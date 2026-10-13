import { useEffect, useRef } from "react";
export function ExitDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    confirm.current?.focus();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="exit-dialog"
      aria-labelledby="exit-title"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onConfirm();
        }
      }}
    >
      <div className="eyebrow">Попытка на паузе</div>
      <h2 id="exit-title">Вернуться к мелодиям?</h2>
      <p>Текущая запись будет удалена. Можно продолжить с той же секунды.</p>
      <div className="dialog-actions">
        <button className="secondary" onClick={onCancel}>
          Продолжить попытку
        </button>
        <button ref={confirm} className="primary" onClick={onConfirm}>
          Выйти к мелодиям
        </button>
      </div>
      <p className="keyboard-hint">
        <kbd>Enter</kbd> выйти <kbd>Esc</kbd> продолжить
      </p>
    </dialog>
  );
}
