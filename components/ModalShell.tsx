"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { XIcon } from "./Icons";
import { ModalBackgroundIsolation, syncModalStackLayers } from "./modal-background-isolation";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ActiveModal {
  root: HTMLElement;
  panel: HTMLElement;
  previousFocus: HTMLElement | null;
  previousZIndex: string;
}

interface ModalEnvironment {
  stack: ActiveModal[];
  isolation: ModalBackgroundIsolation;
  previousBodyOverflow: string | null;
}

interface ModalRegistration {
  isTop: () => boolean;
  unregister: () => void;
}

const modalEnvironments = new WeakMap<Document, ModalEnvironment>();

function environmentFor(document: Document): ModalEnvironment {
  const existing = modalEnvironments.get(document);
  if (existing) return existing;
  const created: ModalEnvironment = {
    stack: [],
    isolation: new ModalBackgroundIsolation(),
    previousBodyOverflow: null,
  };
  modalEnvironments.set(document, created);
  return created;
}

function focusWithoutScrolling(element: HTMLElement | null): void {
  if (!element?.isConnected) return;
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
}

function registerModal(root: HTMLElement, panel: HTMLElement, previousFocus: HTMLElement | null): ModalRegistration {
  const document = root.ownerDocument;
  const environment = environmentFor(document);
  if (environment.stack.length === 0) environment.previousBodyOverflow = document.body.style.overflow;

  const entry: ActiveModal = { root, panel, previousFocus, previousZIndex: root.style.zIndex };
  environment.stack.push(entry);
  syncModalStackLayers(environment.stack.map((modal) => modal.root));
  document.body.style.overflow = "hidden";
  environment.isolation.update(root, document.body);
  let registered = true;

  return {
    isTop: () => registered && environment.stack.at(-1) === entry,
    unregister: () => {
      if (!registered) return;
      registered = false;
      const index = environment.stack.indexOf(entry);
      if (index < 0) return;
      const wasTop = index === environment.stack.length - 1;
      const successor = environment.stack[index + 1];
      if (
        successor &&
        (!successor.previousFocus ||
          !successor.previousFocus.isConnected ||
          entry.root.contains(successor.previousFocus))
      ) {
        successor.previousFocus = entry.previousFocus;
      }
      environment.stack.splice(index, 1);
      root.style.zIndex = entry.previousZIndex;
      syncModalStackLayers(environment.stack.map((modal) => modal.root));

      const next = environment.stack.at(-1) ?? null;
      environment.isolation.update(next?.root ?? null, document.body);
      if (next) {
        document.body.style.overflow = "hidden";
      } else {
        document.body.style.overflow = environment.previousBodyOverflow ?? "";
        environment.previousBodyOverflow = null;
      }

      if (!wasTop) return;
      if (next) {
        const priorWithinNext =
          entry.previousFocus?.isConnected && next.root.contains(entry.previousFocus) ? entry.previousFocus : null;
        focusWithoutScrolling(priorWithinNext ?? next.panel);
      } else {
        focusWithoutScrolling(entry.previousFocus);
      }
    },
  };
}

interface ModalShellProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  dismissible?: boolean;
  maxWidthClassName?: string;
}

export function ModalShell({
  open,
  title,
  description,
  onClose,
  children,
  dismissible = true,
  maxWidthClassName = "max-w-lg",
}: ModalShellProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  onCloseRef.current = onClose;
  dismissibleRef.current = dismissible;
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    const panel = panelRef.current;
    if (!root || !panel) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const registration = registerModal(root, panel, previousFocus);

    const frame = requestAnimationFrame(() => {
      if (!registration.isTop()) return;
      const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panelRef.current)?.focus({ preventScroll: true });
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (!registration.isTop()) return;
      if (event.key === "Escape") {
        if (dismissibleRef.current) {
          event.preventDefault();
          onCloseRef.current();
        }
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;

      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (node) => node.offsetParent !== null,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
      if (activeIndex < 0) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      registration.unregister();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div ref={rootRef} className="fixed inset-0 z-50 overflow-y-auto overscroll-contain p-3 sm:p-6">
      <div
        aria-hidden="true"
        className="animate-fade-in fixed inset-0 bg-black/65 backdrop-blur-sm"
        onMouseDown={() => dismissible && onClose()}
      />
      <div className="relative flex min-h-full items-center justify-center">
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          tabIndex={-1}
          className={`animate-modal-in modal-scroll relative max-h-[calc(100dvh-1.5rem)] w-full overflow-y-auto rounded-2xl border border-border bg-bg-raised p-5 shadow-2xl outline-none sm:max-h-[calc(100dvh-3rem)] sm:p-6 ${maxWidthClassName}`}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id={titleId} className="font-display text-xl text-ivory">
                {title}
              </h2>
              {description && (
                <p id={descriptionId} className="mt-0.5 text-xs text-muted">
                  {description}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={!dismissible}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-faint transition-colors enabled:hover:bg-surface-hover enabled:hover:text-ivory disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={dismissible ? "Close" : "Please wait for the current operation to finish"}
              title={dismissible ? "Close" : "Please wait for the current operation to finish"}
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
