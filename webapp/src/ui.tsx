import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { inTelegram, tg } from './tg';

export function Section(props: { title?: string; footer?: ComponentChildren; children: ComponentChildren; class?: string }) {
  return (
    <section class={`section ${props.class ?? ''}`}>
      {props.title && <h2 class="section-title">{props.title}</h2>}
      <div class="card">{props.children}</div>
      {props.footer && <p class="section-footer">{props.footer}</p>}
    </section>
  );
}

export function Row(props: {
  label: ComponentChildren;
  hint?: ComponentChildren;
  right?: ComponentChildren;
  icon?: ComponentChildren;
  onClick?: () => void;
  children?: ComponentChildren;
  danger?: boolean;
}) {
  const Tag = props.onClick ? 'button' : 'div';
  return (
    <Tag class={`row ${props.onClick ? 'row-btn' : ''} ${props.danger ? 'danger' : ''}`} onClick={props.onClick} type={props.onClick ? 'button' : undefined}>
      {props.icon && <span class="row-icon">{props.icon}</span>}
      <span class="row-main">
        <span class="row-label">{props.label}</span>
        {props.hint && <span class="row-hint">{props.hint}</span>}
        {props.children}
      </span>
      {props.right !== undefined && <span class="row-right">{props.right}</span>}
    </Tag>
  );
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: ComponentChildren; hint?: ComponentChildren; disabled?: boolean }) {
  return (
    <label class={`row toggle-row ${props.disabled ? 'disabled' : ''}`}>
      <span class="row-main">
        <span class="row-label">{props.label}</span>
        {props.hint && <span class="row-hint">{props.hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        class="switch"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange((e.currentTarget as HTMLInputElement).checked)}
      />
    </label>
  );
}

export function Chips<T extends string | number>(props: { options: { value: T; label: ComponentChildren }[]; value: T | null; onChange: (v: T) => void }) {
  return (
    <div class="chips" role="radiogroup">
      {props.options.map((o) => (
        <button
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          class={`chip ${o.value === props.value ? 'active' : ''}`}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>(props: { options: { value: T; label: ComponentChildren }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div class="segmented" role="tablist">
      {props.options.map((o) => (
        <button type="button" role="tab" aria-selected={o.value === props.value} class={o.value === props.value ? 'active' : ''} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner(props: { label?: string }) {
  return (
    <div class="spinner-wrap" aria-busy="true">
      <div class="spinner" />
      {props.label && <p class="hint">{props.label}</p>}
    </div>
  );
}

export function Notice(props: { kind?: 'info' | 'warn' | 'error' | 'success'; children: ComponentChildren }) {
  return <div class={`notice ${props.kind ?? 'info'}`}>{props.children}</div>;
}

/**
 * Нижняя главная кнопка. В Telegram — нативная MainButton (её нет в DOM, поэтому
 * скрипты, кликающие по DOM, до неё не дотягиваются). Вне Telegram — обычная кнопка.
 */
export function MainButton(props: { text: string; onClick: () => void; disabled?: boolean; progress?: boolean; visible?: boolean }) {
  const handler = useRef(props.onClick);
  handler.current = props.onClick;
  const visible = props.visible !== false;

  useEffect(() => {
    if (!inTelegram) return;
    const mb = tg.MainButton;
    const cb = () => handler.current();
    mb.onClick(cb);
    return () => {
      mb.offClick(cb);
      mb.hideProgress();
      mb.hide();
    };
  }, []);

  useEffect(() => {
    if (!inTelegram) return;
    const mb = tg.MainButton;
    mb.setText(props.text);
    if (props.disabled) mb.disable();
    else mb.enable();
    if (props.progress) mb.showProgress(false);
    else mb.hideProgress();
    if (visible) mb.show();
    else mb.hide();
  }, [props.text, props.disabled, props.progress, visible]);

  if (inTelegram || !visible) return null;
  return (
    <div class="mainbutton-bar">
      <button type="button" class="btn primary block" disabled={props.disabled || props.progress} onClick={() => handler.current()}>
        {props.progress ? <span class="spinner small light" /> : props.text}
      </button>
    </div>
  );
}

export function BackButton(props: { onBack: () => void }) {
  const handler = useRef(props.onBack);
  handler.current = props.onBack;
  useEffect(() => {
    if (!inTelegram) return;
    const cb = () => handler.current();
    tg.BackButton.onClick(cb);
    tg.BackButton.show();
    return () => {
      tg.BackButton.offClick(cb);
      tg.BackButton.hide();
    };
  }, []);
  if (inTelegram) return null;
  return (
    <button type="button" class="back-link" onClick={() => handler.current()}>
      ‹ Назад
    </button>
  );
}

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Периодический опрос, пока cond() истинно */
export function usePoll(fn: () => void, ms: number, active: boolean) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms, active]);
}
