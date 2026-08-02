import { useEffect, useRef, useState } from 'react';
import type { PermissionMode } from '../../../../shared/api';
import { MODE_DESCS, MODE_LABELS, MODE_ORDER, MODE_TITLES } from '../../lib/permissionMode';

/**
 * 权限档位 chip + radio 弹层（Codex 对齐改造，DESIGN.md §4 / 附录 B）：
 * 点击 chip 展开三档 radio（档位名 + 一句语义说明，当前档带选中标记），
 * Esc / 点击外部关闭。三档语义不变（附录 A 保留差异化），仅交互形式对齐 Codex。
 * 首页 composer 与任务内 composer 共用；任务内由父组件把 onChange 接到
 * approvals.setPermissionMode（per-task 持久化）。
 *
 * testid 面：permission-mode-chip（保留原 chip testid，e2e 牵连最小化）、
 * permission-mode-popover / permission-mode-option（data-mode 区分档位）。
 */
export function PermissionModePicker(props: {
  mode: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const { mode, onChange } = props;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Esc / 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  return (
    <div className="permission-picker" ref={wrapRef}>
      <button
        type="button"
        className="chip chip-btn"
        data-testid="permission-mode-chip"
        data-mode={mode}
        aria-expanded={open}
        disabled={props.disabled}
        title={MODE_TITLES[mode]}
        onClick={() => setOpen((v) => !v)}
      >
        ⚙ {MODE_LABELS[mode]}
      </button>
      {open && (
        <div className="permission-popover" data-testid="permission-mode-popover" role="menu">
          <p className="permission-popover-title">agent 动作如何审批？</p>
          {MODE_ORDER.map((m) => (
            <button
              key={m}
              type="button"
              className="permission-option"
              data-testid="permission-mode-option"
              data-mode={m}
              aria-pressed={m === mode}
              onClick={() => {
                onChange(m);
                setOpen(false);
              }}
            >
              <span className="permission-option-check" aria-hidden>
                {m === mode ? '✓' : ''}
              </span>
              <span className="permission-option-text">
                <span className="permission-option-label">{MODE_LABELS[m]}</span>
                <span className="permission-option-desc">{MODE_DESCS[m]}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
