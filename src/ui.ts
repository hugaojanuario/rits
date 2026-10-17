// Generic UI primitives: modal, confirm/prompt, context menu, toasts.
import { h } from "./util";
import { icon } from "./icons";
import { displayShortcut } from "./ide/keymap";

const SHORTCUT_RE = /^(Ctrl|Alt|Shift|F\d)/;

export interface ModalHandle {
  root: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
  close: () => void;
}

export function modal(title: string, opts: { width?: number; onClose?: () => void } = {}): ModalHandle {
  const body = h("div.modal-body");
  const footer = h("div.modal-footer");
  const closeBtn = h("button.icon-btn", { title: "Fechar (Esc)" }, icon("close"));
  const box = h(
    "div.modal",
    { style: `width:${opts.width ?? 560}px` },
    h("div.modal-head", null, h("span.modal-title", null, title), closeBtn),
    body,
    footer,
  );
  const overlay = h("div.overlay", null, box);
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  closeBtn.onclick = close;
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
  return { root: box, body, footer, close };
}

export function button(
  label: string,
  onclick: () => void,
  kind: "primary" | "danger" | "" = "",
  ic?: string,
): HTMLButtonElement {
  return h(`button.btn${kind ? "." + kind : ""}` as "button", { onclick }, ic ? icon(ic) : null, label);
}

export function confirmDialog(title: string, message: string, okLabel = "OK", danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const m = modal(title, {
      width: 440,
      onClose: () => {
        if (!done) resolve(false);
      },
    });
    m.body.append(h("div.confirm-text", null, message));
    const ok = button(okLabel, () => {
      done = true;
      m.close();
      resolve(true);
    }, danger ? "danger" : "primary");
    m.footer.append(button("Cancelar", () => m.close()), ok);
    setTimeout(() => ok.focus());
  });
}

export function promptDialog(title: string, label: string, value = ""): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const m = modal(title, { width: 420, onClose: () => !done && resolve(null) });
    const input = h("input.input", { value, spellcheck: false }) as HTMLInputElement;
    const submit = () => {
      done = true;
      m.close();
      resolve(input.value);
    };
    input.addEventListener("keydown", (e) => e.key === "Enter" && submit());
    m.body.append(h("label.field", null, h("span", null, label), input));
    m.footer.append(button("Cancelar", () => m.close()), button("OK", submit, "primary"));
    setTimeout(() => {
      input.focus();
      input.select();
    });
  });
}

export function textViewer(title: string, text: string) {
  const m = modal(title, { width: 760 });
  const ta = h("textarea.viewer", { spellcheck: false, readOnly: true }) as HTMLTextAreaElement;
  ta.value = text;
  m.body.append(ta);
  m.footer.append(
    button("Copiar", () => {
      navigator.clipboard.writeText(text);
      toast("Copiado para a área de transferência");
    }, "", "copy"),
    button("Fechar", () => m.close(), "primary"),
  );
}

export interface MenuItem {
  label?: string;
  icon?: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  action?: () => void;
  separator?: boolean;
  submenu?: MenuItem[];
}

let openMenu: HTMLElement | null = null;

export function closeMenus() {
  openMenu?.remove();
  openMenu = null;
}

document.addEventListener("mousedown", (e) => {
  if (openMenu && !openMenu.contains(e.target as Node)) closeMenus();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenus();
});

function buildMenu(items: MenuItem[]): HTMLElement {
  const menu = h("div.menu");
  for (const it of items) {
    if (it.separator) {
      menu.append(h("div.menu-sep"));
      continue;
    }
    const row = h(
      "div.menu-item",
      { class: [it.danger && "danger", it.disabled && "disabled"].filter(Boolean).join(" ") },
      it.icon ? icon(it.icon) : h("span.ic"),
      h("span.menu-label", null, it.label ?? ""),
      it.shortcut && displayShortcut(it.shortcut) ? h("span.menu-key", null, displayShortcut(it.shortcut)) : null,
      it.submenu ? icon("chevronR", "menu-sub-arrow") : null,
    );
    if (it.submenu) {
      const sub = buildMenu(it.submenu);
      sub.classList.add("submenu");
      row.append(sub);
    } else if (!it.disabled) {
      row.addEventListener("click", () => {
        closeMenus();
        it.action?.();
      });
    }
    menu.append(row);
  }
  return menu;
}

export function contextMenu(x: number, y: number, items: MenuItem[]) {
  closeMenus();
  const menu = buildMenu(items);
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  if (r.right > innerWidth) menu.style.left = Math.max(4, innerWidth - r.width - 4) + "px";
  if (r.bottom > innerHeight) menu.style.top = Math.max(4, innerHeight - r.height - 4) + "px";
  openMenu = menu;
}

export function dropdown(anchor: HTMLElement, items: MenuItem[]) {
  const r = anchor.getBoundingClientRect();
  contextMenu(r.left, r.bottom + 2, items);
}

export function toast(text: string, kind: "info" | "error" | "ok" = "info", ms = 3500) {
  let host = document.querySelector(".toasts");
  if (!host) {
    host = h("div.toasts");
    document.body.append(host);
  }
  const t = h(`div.toast.${kind}` as "div", null, icon(kind === "error" ? "warn" : kind === "ok" ? "check" : "info"), h("span", null, text));
  t.append(toastClose(t));
  host.append(t);
  setTimeout(() => dismissToast(t), ms);
}

function dismissToast(t: HTMLElement) {
  if (t.classList.contains("out")) return;
  t.classList.add("out");
  setTimeout(() => t.remove(), 300);
}

/** Small "×" in the top-right corner of a toast/notification. */
function toastClose(t: HTMLElement) {
  return h("button.toast-close", { title: "Fechar", "aria-label": "Fechar notificação", onclick: (e: MouseEvent) => (e.stopPropagation(), dismissToast(t)) }, icon("general/close"));
}

/** Makes `handle` resize `target` along an axis, persisting size in localStorage. */
export function makeSplitter(
  handle: HTMLElement,
  target: HTMLElement,
  axis: "x" | "y",
  key: string,
  invert = false,
  min = 120,
) {
  try {
    const saved = localStorage.getItem("size:" + key);
    if (saved) target.style[axis === "x" ? "width" : "height"] = saved;
  } catch {
    /* storage unavailable */
  }
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const start = axis === "x" ? e.clientX : e.clientY;
    const startSize = axis === "x" ? target.offsetWidth : target.offsetHeight;
    document.body.classList.add(axis === "x" ? "resizing-x" : "resizing-y");
    const move = (ev: MouseEvent) => {
      const delta = (axis === "x" ? ev.clientX : ev.clientY) - start;
      const size = Math.max(min, startSize + (invert ? -delta : delta));
      target.style[axis === "x" ? "width" : "height"] = size + "px";
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing-x", "resizing-y");
      try {
        localStorage.setItem("size:" + key, target.style[axis === "x" ? "width" : "height"]);
      } catch {
        /* ignore */
      }
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

// ---------------- anchored list popups (project / branch / run config pickers) ----------------

export interface PopupItem {
  label: string;
  icon?: string | HTMLElement;
  sub?: string;
  right?: string;
  current?: boolean;
  section?: string;
  separatorBefore?: boolean;
  action?: () => void;
  /** Nested popup shown when the item is chosen. */
  children?: () => PopupItem[] | Promise<PopupItem[]>;
}

export interface PopupOptions {
  title?: string;
  search?: boolean;
  width?: number;
  tall?: boolean;
  placeholder?: string;
  footer?: HTMLElement;
  /** Denser rows and no title, for quick pickers anchored at a button. */
  compact?: boolean;
}

let openPopupEl: HTMLElement | null = null;
export function closePopup() {
  openPopupEl?.remove();
  openPopupEl = null;
}
document.addEventListener("mousedown", (e) => {
  if (openPopupEl && !openPopupEl.contains(e.target as Node) && !(e.target as HTMLElement).closest(".popup-anchor-open")) closePopup();
});

export function popupList(anchor: HTMLElement | { x: number; y: number }, items: PopupItem[], opts: PopupOptions = {}) {
  closePopup();
  closeMenus();
  const list = h("div.popup-list");
  const searchI = h("input.input.popup-search", { placeholder: opts.placeholder ?? "Buscar…", spellcheck: false }) as HTMLInputElement;
  const pop = h(
    "div.popup",
    { style: `width:${opts.width ?? 380}px`, class: opts.compact ? "compact" : "" },
    opts.title ? h("div.popup-head", null, opts.title) : null,
    opts.search !== false && items.length > 7 ? searchI : null,
    list,
    opts.footer ?? null,
  );
  let active = -1;
  let shown: PopupItem[] = [];
  const render = () => {
    const q = searchI.value.trim().toLowerCase();
    shown = items.filter((it) => !q || it.label.toLowerCase().includes(q) || (it.sub ?? "").toLowerCase().includes(q));
    let lastSection: string | undefined;
    const els: HTMLElement[] = [];
    shown.forEach((it, i) => {
      if (it.separatorBefore && !q) els.push(h("div.popup-sep"));
      if (it.section && it.section !== lastSection && !q) {
        els.push(h("div.popup-section", null, it.section));
        lastSection = it.section;
      }
      const ic = typeof it.icon === "string" ? icon(it.icon) : it.icon ?? null;
      const row = h(
        "div.popup-item",
        { class: [i === active && "active", it.current && "current", (opts.tall || it.sub) && "tall"].filter(Boolean).join(" ") },
        ic,
        h("div.pi-text", null, h("span.pi-main", null, it.label), it.sub ? h("span.pi-sub", null, it.sub) : null),
        it.right ? h("span.pi-right", null, SHORTCUT_RE.test(it.right) ? displayShortcut(it.right) : it.right) : null,
        it.children ? icon("general/chevronRight", "pi-arrow") : null,
      );
      row.addEventListener("mousemove", () => {
        if (active !== i) {
          active = i;
          list.querySelectorAll(".popup-item.active").forEach((x) => x.classList.remove("active"));
          row.classList.add("active");
        }
      });
      row.addEventListener("click", () => choose(i, row));
      els.push(row);
    });
    if (!shown.length) els.push(h("div.empty-note", null, "Nada encontrado"));
    list.replaceChildren(...els);
  };
  const choose = async (i: number, row?: HTMLElement) => {
    const it = shown[i];
    if (!it) return;
    if (it.children) {
      const kids = await it.children();
      const r = (row ?? list.querySelector(".popup-item.active"))?.getBoundingClientRect();
      const pr = pop.getBoundingClientRect();
      popupList({ x: pr.right - 4, y: r ? r.top - 8 : pr.top }, kids, { width: opts.width, search: true });
      return;
    }
    closePopup();
    it.action?.();
  };
  searchI.addEventListener("input", () => {
    active = 0;
    render();
  });
  pop.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") (active = Math.min(shown.length - 1, active + 1)), render(), e.preventDefault();
    else if (e.key === "ArrowUp") (active = Math.max(0, active - 1)), render(), e.preventDefault();
    else if (e.key === "Enter") choose(active), e.preventDefault();
    else if (e.key === "Escape") closePopup();
  });
  render();
  document.body.append(pop);
  const r = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y, top: anchor.y };
  pop.style.left = Math.max(6, Math.min(innerWidth - pop.offsetWidth - 6, r.left)) + "px";
  pop.style.top = Math.min(innerHeight - pop.offsetHeight - 6, (r as DOMRect).bottom + 4) + "px";
  pop.style.maxHeight = innerHeight - 80 + "px";
  pop.tabIndex = -1;
  openPopupEl = pop;
  setTimeout(() => (searchI.isConnected ? searchI.focus() : pop.focus()));
  return pop;
}

export function notify(title: string, body: string, kind: "info" | "error" | "ok" = "info", actions: { label: string; run: () => void }[] = [], ms = 7000) {
  let hostEl = document.querySelector(".toasts");
  if (!hostEl) {
    hostEl = h("div.toasts");
    document.body.append(hostEl);
  }
  const t = h(
    "div.toast",
    null,
    icon(kind === "error" ? "status/error" : kind === "ok" ? "status/success" : "status/info"),
    h(
      "div",
      null,
      h("b", null, title),
      body ? h("div.dim", null, body) : null,
      actions.length
        ? h("div.toast-actions", null, ...actions.map((a) => h("button.link", { onclick: () => (a.run(), t.remove()) }, a.label)))
        : null,
    ),
  );
  t.append(toastClose(t));
  hostEl.append(t);
  setTimeout(() => dismissToast(t), ms);
}
