// Run in the real Tauri WebView through Vite/CDP: import('/dev/completion-smoke.ts').
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, type KeyBinding } from "@codemirror/view";
import { completeFromList, completionStatus, startCompletion, snippet } from "@codemirror/autocomplete";
import { CodeEditor } from "../src/ide/editors";
import { completionExtension, completionTabKeymap } from "../src/ide/completion";
import { createEditor } from "../src/editor";

export async function probeCompletionTab() {
  const previous = localStorage.getItem("completion");
  const previousKeymap = localStorage.getItem("keymap");
  localStorage.setItem("completion", JSON.stringify({tabAccepts:true,auto:false}));
  const parent = document.body.appendChild(document.createElement("div"));
  const results: Record<string, string> = {};
  try {
    for (const mode of ["jetbrains", "vscode"]) {
      localStorage.setItem("keymap", mode);
      for (const delay of [120, 0]) {
        const bindings = (CodeEditor.prototype as unknown as { keymap(): KeyBinding[] }).keymap();
        const view = new EditorView({parent, state:EditorState.create({doc:"pri", selection:{anchor:3}, extensions:[
          completionTabKeymap, completionExtension(),
          EditorState.languageData.of(() => [{autocomplete:completeFromList(["print"])}]),
          keymap.of(bindings),
        ]})});
        startCompletion(view);
        const limit=Date.now()+5000;
        while(completionStatus(view.state)!=="active" && Date.now()<limit) await new Promise(r=>setTimeout(r,1));
        if(completionStatus(view.state)!=="active")throw Error("No code suggestions");
        if(delay)await new Promise(r=>setTimeout(r,delay));
        view.contentDOM.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",code:"Tab",bubbles:true,cancelable:true}));
        await new Promise(r=>setTimeout(r,100));
        results[mode+".code"+delay]=view.state.doc.toString();
        view.destroy();
      }
    }
    const sql=createEditor(parent,"SEL","postgres").view;
    sql.dispatch({selection:{anchor:3}});
    startCompletion(sql);
    const limit=Date.now()+5000;
    while(completionStatus(sql.state)!=="active" && Date.now()<limit)await new Promise(r=>setTimeout(r,5));
    if(completionStatus(sql.state)!=="active")throw Error("No SQL suggestions");
    await new Promise(r=>setTimeout(r,120));
    sql.contentDOM.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",code:"Tab",bubbles:true,cancelable:true}));
    results.sql=sql.state.doc.toString();
    sql.destroy();

    const bindings = (CodeEditor.prototype as unknown as { keymap(): KeyBinding[] }).keymap();
    const plain = () => new EditorView({parent, state:EditorState.create({doc:"pri", selection:{anchor:3}, extensions:[
      completionTabKeymap, completionExtension(),
      EditorState.languageData.of(() => [{autocomplete:completeFromList(["print"])}]), keymap.of(bindings),
    ]})});
    const tab = (view:EditorView,shiftKey=false) => view.contentDOM.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",code:"Tab",shiftKey,bubbles:true,cancelable:true}));
    const ready = async(view:EditorView) => {
      startCompletion(view);
      const limit=Date.now()+5000;
      while(completionStatus(view.state)!=="active" && Date.now()<limit)await new Promise(r=>setTimeout(r,1));
      if(completionStatus(view.state)!=="active")throw Error("No suggestions");
    };
    const idle = plain();
    tab(idle);
    results.noSuggestion=idle.state.doc.toString();
    idle.destroy();

    const disabled=plain();
    await ready(disabled);
    localStorage.setItem("completion",JSON.stringify({tabAccepts:false,auto:false}));
    tab(disabled);
    results.disabled=disabled.state.doc.toString();
    disabled.destroy();
    localStorage.setItem("completion",JSON.stringify({tabAccepts:true,auto:false}));

    const editing=plain();
    await ready(editing);
    tab(editing);
    editing.dispatch({changes:{from:3,insert:"x"},selection:{anchor:4}});
    await new Promise(r=>setTimeout(r,100));
    results.editedBeforeAccept=editing.state.doc.toString();
    editing.destroy();

    const fields=plain();
    snippet("${pri} ${next} ${end}")(fields,{label:"test"},0,3);
    tab(fields);
    results.snippetNavigation=String(fields.state.selection.main.from);
    tab(fields,true);
    results.snippetBack=String(fields.state.selection.main.from);
    fields.destroy();

    const nested=plain();
    snippet("${pri} ${next}")(nested,{label:"test"},0,3);
    nested.dispatch({selection:{anchor:3}});
    await ready(nested);
    tab(nested);
    await new Promise(r=>setTimeout(r,100));
    results.completionInSnippet=nested.state.doc.toString();
    nested.destroy();

    for(const [name,expected] of Object.entries({"jetbrains.code120":"print","jetbrains.code0":"print","vscode.code120":"print","vscode.code0":"print",sql:"SELECT",noSuggestion:"  pri",disabled:"  pri",editedBeforeAccept:"prix",snippetNavigation:"4",snippetBack:"0",completionInSnippet:"print next"})) {
      if(results[name]!==expected)throw Error(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(results[name])}`);
    }
    return results;
  } finally {
    if(previous===null)localStorage.removeItem("completion");else localStorage.setItem("completion",previous);
    if(previousKeymap===null)localStorage.removeItem("keymap");else localStorage.setItem("keymap",previousKeymap);
    parent.remove();
  }
}
