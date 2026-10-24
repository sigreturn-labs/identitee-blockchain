// The small line icons of the row actions (Copy, Remove, Undo...), drawn here rather than taken
// from a library: one 24 unit grid, a 1.75 stroke in the text colour, round ends. An icon is
// decoration: the button that carries it is named by its aria-label.

import type { ComponentChildren } from "preact";

function Icon({ name, size, children }: { name: string; size: number; children: ComponentChildren }) {
  return (
    <svg
      class="icon"
      data-icon={name}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

type Props = { size?: number };

export const CopyIcon = ({ size = 16 }: Props) => (
  <Icon name="copy" size={size}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
  </Icon>
);

export const CheckIcon = ({ size = 16 }: Props) => (
  <Icon name="check" size={size}>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
);

export const XIcon = ({ size = 16 }: Props) => (
  <Icon name="x" size={size}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Icon>
);

export const TrashIcon = ({ size = 16 }: Props) => (
  <Icon name="trash" size={size}>
    <path d="M4 7h16" />
    <path d="M9 7V4.5h6V7" />
    <path d="m6 7 1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7" />
  </Icon>
);

export const UndoIcon = ({ size = 16 }: Props) => (
  <Icon name="undo" size={size}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Icon>
);

export const PencilIcon = ({ size = 16 }: Props) => (
  <Icon name="pencil" size={size}>
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    <path d="m14.5 5.5 3 3" />
  </Icon>
);

export const ChevronUpIcon = ({ size = 16 }: Props) => (
  <Icon name="chevron-up" size={size}>
    <path d="m18 15-6-6-6 6" />
  </Icon>
);

export const ChevronDownIcon = ({ size = 16 }: Props) => (
  <Icon name="chevron-down" size={size}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

export const EyeIcon = ({ size = 16 }: Props) => (
  <Icon name="eye" size={size}>
    <path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

export const LockIcon = ({ size = 16 }: Props) => (
  <Icon name="lock" size={size}>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Icon>
);

export const LockOpenIcon = ({ size = 16 }: Props) => (
  <Icon name="lock-open" size={size}>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 7.75-1.4" />
  </Icon>
);

export const PlusIcon = ({ size = 16 }: Props) => (
  <Icon name="plus" size={size}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Icon>
);

/** A button that shows only an icon: `label` names it for screen readers (aria-label) and for the
 * pointer (title), so the two never drift apart. */
export function IconButton({
  label,
  children,
  class: extra,
  ...rest
}: {
  label: string;
  children: ComponentChildren;
  class?: string;
  id?: string;
  disabled?: boolean;
  "aria-expanded"?: boolean;
  onClick(): void;
}) {
  return (
    <button class={extra ? `icon-button ${extra}` : "icon-button"} type="button" aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}
