/**
 * Fill colors for work item state badges. The badges draw white text on these, so every color
 * keeps a contrast of at least 4.5:1 against white (WCAG AA for normal text) in any theme.
 */

export const STATE_COLORS = {
    proposed: '#0078d4',
    inProgress: '#a35200',
    resolved: '#6b6b00',
    completed: '#107c10',
    removed: '#d13438',
    other: '#6e6e6e'
} as const;

const BY_STATE: Record<string, string> = {
    'new': STATE_COLORS.proposed,
    'to do': STATE_COLORS.proposed,
    'proposed': STATE_COLORS.proposed,
    'approved': STATE_COLORS.proposed,
    'active': STATE_COLORS.inProgress,
    'in progress': STATE_COLORS.inProgress,
    'committed': STATE_COLORS.inProgress,
    'doing': STATE_COLORS.inProgress,
    'resolved': STATE_COLORS.resolved,
    'done': STATE_COLORS.completed,
    'closed': STATE_COLORS.completed,
    'completed': STATE_COLORS.completed,
    'removed': STATE_COLORS.removed,
    'cut': STATE_COLORS.removed
};

/** The badge color for a state name, matched without regard to case. */
export function stateColor(state: string | undefined): string {
    return BY_STATE[(state || '').trim().toLowerCase()] ?? STATE_COLORS.other;
}

/**
 * Fills for avatar initials, picked by a hash of the person's name. White initials keep 4.5:1 on
 * each. media/board/board.js keeps its own copy of this list (a unit test checks it matches).
 */
export const AVATAR_COLORS = [
    '#0078d4', '#8764b8', '#107c10', '#c4314b', '#a35200',
    '#038387', '#5c2e91', '#b4009e', '#4f6bed', '#986f0b'
] as const;

/** The avatar fill for a name; the same name always gets the same color. */
export function avatarColor(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/** WCAG contrast ratio between two #rrggbb colors. */
export function contrastRatio(a: string, b: string): number {
    const luminance = (hex: string) => {
        const [r, g, bl] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
            .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}
