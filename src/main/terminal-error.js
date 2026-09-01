export function getTerminalErrorMessage(error) {
    if (error instanceof Error && /enoent/i.test(error.message)) {
        return process.platform === 'win32'
            ? 'WSL could not be started. Make sure your default WSL distro is installed and available.'
            : 'Agent CLI shell could not be started. Make sure your login shell is available.';
    }
    return error instanceof Error ? error.message : String(error);
}
