import { createPortal } from "react-dom";

export type PmsHkRequestChoice = 0 | 1 | 2;

type Props = {
  open: boolean;
  selectedCount: number;
  requestStatus: PmsHkRequestChoice;
  busy: boolean;
  error: string | null;
  onRequestStatusChange: (status: PmsHkRequestChoice) => void;
  onClose: () => void;
  onSend: () => void;
};

export function PmsHousekeepingDialog({
  open,
  selectedCount,
  requestStatus,
  busy,
  error,
  onRequestStatusChange,
  onClose,
  onSend,
}: Props) {
  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pms-hk-dialog-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl">
        <h3 id="pms-hk-dialog-title" className="text-base font-semibold text-[var(--text-h)]">
          {selectedCount} room{selectedCount === 1 ? "" : "s"} selected
        </h3>

        <table className="mt-4 w-full text-sm">
          <tbody>
            <tr>
              <td className="w-10 py-2 align-middle">
                <input
                  id="pms-hk-clean"
                  type="checkbox"
                  checked={requestStatus === 2}
                  onChange={(e) => onRequestStatusChange(e.target.checked ? 2 : 0)}
                />
              </td>
              <td className="py-2">
                <label htmlFor="pms-hk-clean" className="cursor-pointer">
                  Mark them clean
                </label>
              </td>
            </tr>
            <tr>
              <td className="w-10 py-2 align-middle">
                <input
                  id="pms-hk-dirty"
                  type="checkbox"
                  checked={requestStatus === 1}
                  onChange={(e) => onRequestStatusChange(e.target.checked ? 1 : 0)}
                />
              </td>
              <td className="py-2">
                <label htmlFor="pms-hk-dirty" className="cursor-pointer">
                  Mark them dirty
                </label>
              </td>
            </tr>
          </tbody>
        </table>

        {error ? (
          <p className="mt-3 text-sm text-red-500" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || requestStatus === 0}
            onClick={onSend}
          >
            {busy ? "Sending…" : "Send Request"}
          </button>
        </div>

        <p className="mt-4 text-xs text-[var(--text-muted)]">
          <strong>Note:</strong> It takes up to 60 seconds for the housekeeping status change
          request to take effect.
        </p>
      </div>
    </div>,
    document.body,
  );
}
