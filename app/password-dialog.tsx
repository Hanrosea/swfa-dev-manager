import { useEffect, useRef, useState, type FormEvent } from "react";
import { changeAccountPassword } from "@/lib/supabase";

type Props = {
  userId: string;
  email: string;
  onClose: () => void;
  onSaved: () => void;
};

export function PasswordDialog({ userId, email, onClose, onSaved }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const current = String(fields.get("currentPassword"));
    const next = String(fields.get("newPassword"));
    if (next !== fields.get("confirmation")) {
      setError("새 비밀번호와 확인 입력이 일치하지 않습니다.");
      form.querySelector<HTMLInputElement>('[name="confirmation"]')?.focus();
      return;
    }
    if (next === current) {
      setError("현재 비밀번호와 다른 새 비밀번호를 입력해 주세요.");
      return;
    }
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      const message = await changeAccountPassword(userId, current, next);
      if (!dialog.current?.open) return;
      if (message) setError(message);
      else {
        form.reset();
        onSaved();
      }
    } catch {
      setError("변경 결과를 확인하지 못했습니다. 네트워크 연결을 확인해 주세요.");
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return (
    <dialog className="password-dialog" ref={dialog} aria-labelledby="password-title"
      onCancel={event => { event.preventDefault(); if (!pending.current) onClose(); }}>
      <form onSubmit={submit}>
        <header>
          <h2 id="password-title">비밀번호 변경</h2>
          <p>{email}</p>
        </header>
        <input type="hidden" name="username" autoComplete="username" value={email} />
        <fieldset disabled={saving}>
          <label>현재 비밀번호
            <input type="password" name="currentPassword" autoComplete="current-password" required />
          </label>
          <div>
            <label>새 비밀번호
              <input type="password" name="newPassword" autoComplete="new-password" minLength={8} required aria-describedby="password-length" />
            </label>
            <small id="password-length">8자 이상 입력해 주세요.</small>
          </div>
          <label>새 비밀번호 확인
            <input type="password" name="confirmation" autoComplete="new-password" required />
          </label>
        </fieldset>
        {error && <p className="form-error" role="alert">{error}</p>}
        <footer>
          <button type="button" disabled={saving} onClick={onClose}>취소</button>
          <button className="primary-button" type="submit" disabled={saving}>{saving ? "변경 중…" : "변경"}</button>
        </footer>
      </form>
    </dialog>
  );
}
