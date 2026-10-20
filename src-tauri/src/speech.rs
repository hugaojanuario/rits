// Dictation for the AI assistant: the operating system's speech recognition, no models downloaded
// and no API keys. macOS: Speech framework (on-device when the language supports it) fed by the
// microphone through AVAudioEngine. Windows: WinRT continuous dictation (Windows.Media.SpeechRecognition).
//
// One session at a time for the whole app. The transcript goes to the window that started it as
// the "speech" event: {kind: "text", text, final} with the full text of the session so far, then
// {kind: "end"} or {kind: "error", text}.
use tauri::AppHandle;
#[cfg(any(target_os = "macos", windows))]
use tauri::Emitter;

#[cfg(any(target_os = "macos", windows))]
#[derive(serde::Serialize, Clone)]
pub struct SpeechEvent {
    pub kind: &'static str,
    pub text: String,
    #[serde(rename = "final")]
    pub is_final: bool,
}

#[cfg(any(target_os = "macos", windows))]
fn send(app: &AppHandle, owner: &str, kind: &'static str, text: String, is_final: bool) {
    let _ = app.emit_to(owner, "speech", SpeechEvent { kind, text, is_final });
}

/// "pt-BR", "en_US" → a BCP 47 tag with "-" (Windows) and the underscore form (macOS NSLocale).
pub fn normalize_lang(lang: &str) -> String {
    let t = lang.trim().replace('_', "-");
    let mut parts = t.split('-').filter(|p| !p.is_empty());
    match (parts.next(), parts.next()) {
        (Some(l), Some(r)) if l.chars().all(|c| c.is_ascii_alphabetic()) && r.chars().all(|c| c.is_ascii_alphanumeric()) => format!("{}-{}", l.to_ascii_lowercase(), r.to_ascii_uppercase()),
        (Some(l), None) if l.chars().all(|c| c.is_ascii_alphabetic()) && !l.is_empty() => l.to_ascii_lowercase(),
        _ => "pt-BR".into(),
    }
}

#[tauri::command]
pub async fn speech_start(app: AppHandle, window: tauri::Window, lang: String) -> Result<(), String> {
    imp::start(app, window.label().to_string(), normalize_lang(&lang)).await
}

/// Stops listening; the final text still arrives, then "end".
#[tauri::command]
pub async fn speech_stop(app: AppHandle) -> Result<(), String> {
    imp::stop(app, false).await
}

/// Stops without waiting for the final text (window reloaded or closed).
pub fn cancel_owner(app: &AppHandle, owner: &str) {
    imp::cancel_owner(app, owner);
}

// ---------------- macOS ----------------

#[cfg(target_os = "macos")]
mod imp {
    use super::send;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, NSObjectProtocol};
    use objc2::{sel, AllocAnyThread};
    use objc2_avf_audio::{AVAudioApplication, AVAudioApplicationRecordPermission, AVAudioEngine, AVAudioInputNode, AVAudioPCMBuffer, AVAudioTime};
    use objc2_foundation::{NSError, NSLocale, NSString};
    use objc2_speech::{SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask, SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus};
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Arc;
    use std::ptr::NonNull;
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::AppHandle;

    struct Session {
        owner: String,
        engine: Retained<AVAudioEngine>,
        input: Retained<AVAudioInputNode>,
        request: Retained<SFSpeechAudioBufferRecognitionRequest>,
        task: Retained<SFSpeechRecognitionTask>,
    }

    thread_local! {
        // lives on the main thread only (AppKit objects, audio engine)
        static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
        // a stopped session whose task is still delivering the final text
        static FINISHING: RefCell<Option<Retained<SFSpeechRecognitionTask>>> = const { RefCell::new(None) };
        // one recognizer per language, reused: right after creation a recognizer may report no
        // on-device support yet, which used to send the second dictation to Apple's servers
        static RECOGNIZERS: RefCell<HashMap<String, Retained<SFSpeechRecognizer>>> = RefCell::new(HashMap::new());
    }

    /// Generation of the current session: callbacks of older tasks (canceled or finishing late)
    /// must not touch the chat of a newer one.
    static GEN: AtomicU64 = AtomicU64::new(0);

    const DICTATION_OFF: &str = "O Ditado do macOS está desligado e este idioma não está disponível para reconhecimento no próprio Mac. Ative o Ditado em Ajustes do Sistema › Teclado › Ditado (lá também dá para baixar o idioma para uso sem internet) e tente de novo.";

    fn explain(e: &NSError) -> String {
        let msg = e.localizedDescription().to_string();
        if msg.contains("Siri") || msg.contains("Dictation") || msg.contains("Ditado") {
            DICTATION_OFF.into()
        } else {
            format!("Reconhecimento de fala do macOS: {msg}")
        }
    }

    const SPEECH_DENIED: &str = "O Rits não tem permissão para o reconhecimento de fala. Libere em Ajustes do Sistema › Privacidade e Segurança › Reconhecimento de Fala e tente de novo.";
    const MIC_DENIED: &str = "O Rits não tem permissão para usar o microfone. Libere em Ajustes do Sistema › Privacidade e Segurança › Microfone e tente de novo.";

    async fn wait<T: Send + 'static>(rx: mpsc::Receiver<T>) -> Option<T> {
        tokio::task::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(300)).ok()).await.ok().flatten()
    }

    fn ask_speech() -> mpsc::Receiver<isize> {
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |s: SFSpeechRecognizerAuthorizationStatus| {
            let _ = tx.send(s.0);
        });
        unsafe { SFSpeechRecognizer::requestAuthorization(&block) };
        rx
    }

    /// None: no AVAudioApplication (before macOS 14; the engine asks on start).
    fn mic_permission() -> Option<AVAudioApplicationRecordPermission> {
        AnyClass::get(c"AVAudioApplication")?;
        Some(unsafe { AVAudioApplication::sharedInstance().recordPermission() })
    }

    fn ask_mic() -> mpsc::Receiver<bool> {
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |ok: objc2::runtime::Bool| {
            let _ = tx.send(ok.as_bool());
        });
        unsafe { AVAudioApplication::requestRecordPermissionWithCompletionHandler(&block) };
        rx
    }

    async fn authorize() -> Result<(), String> {
        let mut status = unsafe { SFSpeechRecognizer::authorizationStatus() }.0;
        if status == SFSpeechRecognizerAuthorizationStatus::NotDetermined.0 {
            let rx = ask_speech();
            status = wait(rx).await.unwrap_or(1);
        }
        if status != SFSpeechRecognizerAuthorizationStatus::Authorized.0 {
            return Err(SPEECH_DENIED.into());
        }
        match mic_permission() {
            Some(p) if p == AVAudioApplicationRecordPermission::Undetermined => {
                let rx = ask_mic();
                if !wait(rx).await.unwrap_or(false) {
                    return Err(MIC_DENIED.into());
                }
            }
            Some(p) if p == AVAudioApplicationRecordPermission::Denied => return Err(MIC_DENIED.into()),
            _ => {}
        }
        Ok(())
    }

    fn tear_down(s: &Session, finish: bool) {
        unsafe {
            s.engine.stop();
            s.input.removeTapOnBus(0);
            s.request.endAudio();
            if !finish {
                s.task.cancel();
            }
        }
    }

    /// Runs on the main thread.
    fn recognizer(lang: &str) -> Option<Retained<SFSpeechRecognizer>> {
        RECOGNIZERS.with(|cell| {
            if let Some(r) = cell.borrow().get(lang) {
                return Some(r.clone());
            }
            let locale = NSLocale::initWithLocaleIdentifier(NSLocale::alloc(), &NSString::from_str(&lang.replace('-', "_")));
            let r = unsafe { SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &locale) }?;
            cell.borrow_mut().insert(lang.to_string(), r.clone());
            Some(r)
        })
    }

    /// `attempt` 0 and 1 recognize on the Mac (the audio does not leave it); when both fail
    /// before any text, attempt 2 goes through Apple's servers (needs Dictation on).
    fn begin(app: AppHandle, owner: String, lang: String, attempt: u8) -> Result<(), String> {
        let on_device = attempt < 2;
        let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
        SESSION.with(|cell| {
            if let Some(old) = cell.borrow_mut().take() {
                tear_down(&old, false);
            }
        });
        // the previous dictation may still hold the local recognizer
        FINISHING.with(|f| {
            if let Some(t) = f.borrow_mut().take() {
                unsafe { t.cancel() };
            }
        });
        unsafe {
            let recognizer = recognizer(&lang).ok_or_else(|| format!("O reconhecimento de fala do macOS não suporta o idioma {lang}."))?;
            if !on_device && !recognizer.isAvailable() {
                return Err(DICTATION_OFF.into());
            }
            let request = SFSpeechAudioBufferRecognitionRequest::new();
            request.setShouldReportPartialResults(true);
            request.setRequiresOnDeviceRecognition(on_device);
            if request.respondsToSelector(sel!(setAddsPunctuation:)) {
                request.setAddsPunctuation(true);
            }

            let engine = AVAudioEngine::new();
            let input = engine.inputNode();
            let format = input.outputFormatForBus(0);
            if format.sampleRate() <= 0.0 || format.channelCount() == 0 {
                return Err("Nenhum microfone disponível.".into());
            }
            let req = request.clone();
            let tap = RcBlock::new(move |buf: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| {
                req.appendAudioPCMBuffer(buf.as_ref());
            });
            input.installTapOnBus_bufferSize_format_block(0, 1024, Some(&format), RcBlock::as_ptr(&tap));
            engine.prepare();
            if let Err(e) = engine.startAndReturnError() {
                input.removeTapOnBus(0);
                return Err(format!("Não foi possível abrir o microfone: {}", e.localizedDescription()));
            }

            let (app2, owner2, lang2) = (app.clone(), owner.clone(), lang.clone());
            let heard = Arc::new(AtomicBool::new(false));
            let handler = RcBlock::new(move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
                if GEN.load(Ordering::SeqCst) != gen {
                    return;
                }
                let mut done = false;
                if let Some(r) = result.as_ref() {
                    let text = r.bestTranscription().formattedString().to_string();
                    let fin = r.isFinal();
                    heard.store(true, Ordering::SeqCst);
                    send(&app2, &owner2, "text", text, fin);
                    done = fin;
                }
                if let Some(e) = error.as_ref() {
                    // 1110: no speech; 216/301/203: canceled — a plain end, not an error
                    let code = e.code();
                    if [1110, 216, 301, 203].contains(&code) {
                        send(&app2, &owner2, "end", String::new(), true);
                    } else if on_device && !heard.load(Ordering::SeqCst) {
                        // the Mac could not do it locally: once more through Apple's servers
                        let (a, o, l) = (app2.clone(), owner2.clone(), lang2.clone());
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(if attempt == 0 { 400 } else { 0 }));
                            let a2 = a.clone();
                            let _ = a2.run_on_main_thread(move || {
                                if GEN.load(Ordering::SeqCst) == gen {
                                    if let Err(msg) = begin(a.clone(), o.clone(), l, attempt + 1) {
                                        send(&a, &o, "error", msg, true);
                                    }
                                }
                            });
                        });
                    } else {
                        send(&app2, &owner2, "error", explain(e), true);
                    }
                } else if done {
                    send(&app2, &owner2, "end", String::new(), true);
                }
            });
            let task = recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler);
            SESSION.with(|cell| *cell.borrow_mut() = Some(Session { owner, engine, input, request, task }));
        }
        Ok(())
    }

    pub async fn start(app: AppHandle, owner: String, lang: String) -> Result<(), String> {
        authorize().await?;
        let (tx, rx) = mpsc::channel();
        let app2 = app.clone();
        app.run_on_main_thread(move || {
            let _ = tx.send(begin(app2, owner, lang, 0));
        })
        .map_err(|e| e.to_string())?;
        wait(rx).await.unwrap_or_else(|| Err("O reconhecimento de fala não respondeu.".into()))
    }

    pub async fn stop(app: AppHandle, _cancel: bool) -> Result<(), String> {
        app.run_on_main_thread(|| {
            SESSION.with(|cell| {
                if let Some(s) = cell.borrow_mut().take() {
                    tear_down(&s, true);
                    FINISHING.with(|f| *f.borrow_mut() = Some(s.task));
                }
            })
        })
        .map_err(|e| e.to_string())
    }

    pub fn cancel_owner(app: &AppHandle, owner: &str) {
        let owner = owner.to_string();
        let _ = app.run_on_main_thread(move || {
            SESSION.with(|cell| {
                let mine = cell.borrow().as_ref().is_some_and(|s| s.owner == owner);
                if mine {
                    if let Some(s) = cell.borrow_mut().take() {
                        GEN.fetch_add(1, Ordering::SeqCst);
                        tear_down(&s, false);
                    }
                }
            })
        });
    }
}

// ---------------- Windows ----------------

#[cfg(windows)]
mod imp {
    use super::send;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use tauri::AppHandle;
    use windows::core::{Interface, HSTRING};
    use windows::Foundation::{TimeSpan, TypedEventHandler};
    use windows::Globalization::Language;
    use windows::Media::SpeechRecognition::{
        ISpeechRecognitionConstraint, SpeechContinuousRecognitionCompletedEventArgs, SpeechContinuousRecognitionResultGeneratedEventArgs, SpeechContinuousRecognitionSession, SpeechRecognitionHypothesisGeneratedEventArgs,
        SpeechRecognitionResultStatus, SpeechRecognitionScenario, SpeechRecognitionTopicConstraint, SpeechRecognizer,
    };

    /// Generation of the current session: a canceled one must not end the next in the chat.
    static GEN: AtomicU64 = AtomicU64::new(0);

    fn emit(app: &AppHandle, owner: &str, gen: u64, kind: &'static str, text: String, is_final: bool) {
        if GEN.load(Ordering::SeqCst) == gen {
            send(app, owner, kind, text, is_final);
        }
    }

    struct Active {
        owner: String,
        stop: mpsc::Sender<bool>,
    }

    static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);

    const PRIVACY: &str = "O reconhecimento de fala do Windows está desligado. Ative em Configurações › Privacidade e segurança › Fala › Reconhecimento de fala online e confira se o acesso ao microfone está liberado para aplicativos da área de trabalho.";

    fn explain(e: &windows::core::Error) -> String {
        match e.code().0 as u32 {
            0x80045509 => PRIVACY.into(),
            0x80070005 => "O Windows negou o acesso ao microfone. Libere em Configurações › Privacidade e segurança › Microfone (inclusive para aplicativos da área de trabalho).".into(),
            _ => format!("Reconhecimento de fala do Windows: {}", e.message()),
        }
    }

    fn status_text(s: SpeechRecognitionResultStatus) -> Option<String> {
        match s {
            SpeechRecognitionResultStatus::Success | SpeechRecognitionResultStatus::UserCanceled | SpeechRecognitionResultStatus::TimeoutExceeded | SpeechRecognitionResultStatus::PauseLimitExceeded => None,
            SpeechRecognitionResultStatus::TopicLanguageNotSupported => Some("O Windows não tem o reconhecimento de fala para este idioma. Instale o pacote de fala em Configurações › Hora e idioma › Fala.".into()),
            SpeechRecognitionResultStatus::NetworkFailure => Some("Sem conexão com o serviço de fala do Windows.".into()),
            SpeechRecognitionResultStatus::MicrophoneUnavailable => Some("Nenhum microfone disponível.".into()),
            SpeechRecognitionResultStatus::AudioQualityFailure => Some("O áudio do microfone está ruim demais para reconhecer.".into()),
            _ => Some("O reconhecimento de fala do Windows falhou.".into()),
        }
    }

    /// Dedicated MTA thread: WinRT blocking waits are not allowed on the UI (STA) thread.
    fn run(app: AppHandle, owner: String, gen: u64, lang: String, ready: mpsc::Sender<Result<(), String>>, stop: mpsc::Receiver<bool>) {
        let setup = || -> windows::core::Result<(SpeechRecognizer, SpeechContinuousRecognitionSession, Option<String>)> {
            let rec = match Language::CreateLanguage(&HSTRING::from(lang.as_str())).and_then(|l| SpeechRecognizer::Create(&l)) {
                Ok(r) => r,
                Err(_) => SpeechRecognizer::new()?,
            };
            let topic = SpeechRecognitionTopicConstraint::Create(SpeechRecognitionScenario::Dictation, &HSTRING::from("dictation"))?;
            rec.Constraints()?.Append(&topic.cast::<ISpeechRecognitionConstraint>()?)?;
            let compiled = rec.CompileConstraintsAsync()?.join()?;
            let problem = status_text(compiled.Status()?);
            let session = rec.ContinuousRecognitionSession()?;
            // explicit stop by the user; a long silence also ends it
            let _ = session.SetAutoStopSilenceTimeout(TimeSpan { Duration: 60 * 10_000_000 });
            Ok((rec, session, problem))
        };
        let (rec, session) = match setup() {
            Ok((_, _, Some(p))) => return drop(ready.send(Err(p))),
            Ok((r, s, None)) => (r, s),
            Err(e) => return drop(ready.send(Err(explain(&e)))),
        };
        // finals accumulate; the hypothesis is the segment being spoken
        let finals = Arc::new(Mutex::new(String::new()));
        let join = |a: &str, b: &str| if a.is_empty() { b.to_string() } else if b.is_empty() { a.to_string() } else { format!("{a} {b}") };
        let (a1, o1, f1) = (app.clone(), owner.clone(), finals.clone());
        let _ = rec.HypothesisGenerated(&TypedEventHandler::new(move |_, args: windows::core::Ref<SpeechRecognitionHypothesisGeneratedEventArgs>| {
            if let Some(a) = args.as_ref() {
                let h = a.Hypothesis()?.Text()?.to_string();
                let all = join(&f1.lock().unwrap_or_else(|p| p.into_inner()), &h);
                emit(&a1, &o1, gen, "text", all, false);
            }
            Ok(())
        }));
        let (a2, o2, f2) = (app.clone(), owner.clone(), finals.clone());
        let _ = session.ResultGenerated(&TypedEventHandler::new(move |_, args: windows::core::Ref<SpeechContinuousRecognitionResultGeneratedEventArgs>| {
            if let Some(a) = args.as_ref() {
                let t = a.Result()?.Text()?.to_string();
                let mut f = f2.lock().unwrap_or_else(|p| p.into_inner());
                *f = join(&f, &t);
                emit(&a2, &o2, gen, "text", f.clone(), true);
            }
            Ok(())
        }));
        let (a3, o3) = (app.clone(), owner.clone());
        let _ = session.Completed(&TypedEventHandler::new(move |_, args: windows::core::Ref<SpeechContinuousRecognitionCompletedEventArgs>| {
            match args.as_ref().and_then(|a| a.Status().ok()).and_then(status_text) {
                Some(err) => emit(&a3, &o3, gen, "error", err, true),
                None => emit(&a3, &o3, gen, "end", String::new(), true),
            }
            Ok(())
        }));
        if let Err(e) = session.StartAsync().and_then(|op| op.join()) {
            return drop(ready.send(Err(explain(&e))));
        }
        let _ = ready.send(Ok(()));
        // true = stop and deliver the final text, false = cancel
        let finish = stop.recv().unwrap_or(false);
        let _ = if finish { session.StopAsync().and_then(|op| op.join()) } else { session.CancelAsync().and_then(|op| op.join()) };
        if !finish {
            emit(&app, &owner, gen, "end", String::new(), true);
        }
        let _ = rec.Close();
    }

    pub async fn start(app: AppHandle, owner: String, lang: String) -> Result<(), String> {
        cancel_all();
        let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
        let (ready_tx, ready_rx) = mpsc::channel();
        let (stop_tx, stop_rx) = mpsc::channel();
        let o = owner.clone();
        std::thread::spawn(move || {
            unsafe {
                let _ = windows::Win32::System::WinRT::RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED);
            }
            run(app, o, gen, lang, ready_tx, stop_rx);
        });
        let r = tokio::task::spawn_blocking(move || ready_rx.recv_timeout(std::time::Duration::from_secs(60)).unwrap_or_else(|_| Err("O reconhecimento de fala do Windows não respondeu.".into())))
            .await
            .map_err(|e| e.to_string())?;
        if r.is_ok() {
            *ACTIVE.lock().unwrap_or_else(|p| p.into_inner()) = Some(Active { owner, stop: stop_tx });
        }
        r
    }

    fn cancel_all() {
        if let Some(a) = ACTIVE.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = a.stop.send(false);
        }
    }

    pub async fn stop(_app: AppHandle, cancel: bool) -> Result<(), String> {
        if let Some(a) = ACTIVE.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = a.stop.send(!cancel);
        }
        Ok(())
    }

    pub fn cancel_owner(_app: &AppHandle, owner: &str) {
        let mut g = ACTIVE.lock().unwrap_or_else(|p| p.into_inner());
        if g.as_ref().is_some_and(|a| a.owner == owner) {
            if let Some(a) = g.take() {
                let _ = a.stop.send(false);
            }
        }
    }
}

// ---------------- other systems ----------------

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    use tauri::AppHandle;
    pub async fn start(_app: AppHandle, _owner: String, _lang: String) -> Result<(), String> {
        Err("Ditado disponível só no macOS e no Windows.".into())
    }
    pub async fn stop(_app: AppHandle, _cancel: bool) -> Result<(), String> {
        Ok(())
    }
    pub fn cancel_owner(_app: &AppHandle, _owner: &str) {}
}

#[cfg(test)]
mod tests {
    use super::normalize_lang;

    #[test]
    fn language_tags() {
        assert_eq!(normalize_lang("pt-BR"), "pt-BR");
        assert_eq!(normalize_lang("pt_br"), "pt-BR");
        assert_eq!(normalize_lang(" en-us "), "en-US");
        assert_eq!(normalize_lang("es"), "es");
        assert_eq!(normalize_lang(""), "pt-BR");
        assert_eq!(normalize_lang("x; rm -rf"), "pt-BR");
    }
}
