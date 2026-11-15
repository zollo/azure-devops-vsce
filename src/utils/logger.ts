import type * as vscode from 'vscode';

/**
 * Extension logging. Messages go to the "Azure DevOps" output channel, where the person can
 * pick the level (Output panel > gear, or "Developer: Set Log Level"). Debug and trace
 * messages, such as every request URL, are hidden at the default Info level.
 * Before the channel exists (and in unit tests) messages go to the console.
 */
let channel: vscode.LogOutputChannel | undefined;

export function setLogChannel(logChannel: vscode.LogOutputChannel | undefined): void {
    channel = logChannel;
}

const MAX_DETAIL = 2000;

/** Formats one log argument. Axios errors are summarised so tokens in request headers never reach the log. */
export function formatLogArg(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    const err = value as any;
    if (err && (err.isAxiosError || (err.config && err.response !== undefined))) {
        const status = err.response?.status ? ` (HTTP ${err.response.status})` : '';
        const method = err.config?.method ? `${String(err.config.method).toUpperCase()} ` : '';
        const url = err.config?.url ? ` ${method}${err.config.url}` : '';
        const serverMessage = err.response?.data?.message ? `: ${err.response.data.message}` : '';
        return `${err.message}${status}${url}${serverMessage}`;
    }
    if (value instanceof Error) {
        return value.stack || value.message;
    }
    try {
        const text = JSON.stringify(value);
        if (text === undefined) {
            return String(value);
        }
        return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
    } catch {
        return String(value);
    }
}

function format(args: unknown[]): string {
    return args.map(formatLogArg).join(' ');
}

export const log = {
    trace(...args: unknown[]): void {
        if (channel) { channel.trace(format(args)); }
    },
    debug(...args: unknown[]): void {
        if (channel) { channel.debug(format(args)); } else { console.debug(format(args)); }
    },
    info(...args: unknown[]): void {
        if (channel) { channel.info(format(args)); } else { console.info(format(args)); }
    },
    warn(...args: unknown[]): void {
        if (channel) { channel.warn(format(args)); } else { console.warn(format(args)); }
    },
    error(...args: unknown[]): void {
        if (channel) { channel.error(format(args)); } else { console.error(format(args)); }
    }
};
