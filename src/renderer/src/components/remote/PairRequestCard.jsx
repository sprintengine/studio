import React from 'react';
import { PAIR_REQUEST_CODE_ATTEMPTS } from '../../../../shared/tailnet';
import { Input, OutlineButton, PrimaryButton, StatusDot } from '../ui';
import { pairRequestAnswerable } from '../settings/tailnetPanelModel';
import { showToast } from '../../store/toastStore';
// The ACTING surface for a request from another machine, shared by the
// Remote popover and Settings → Remote (pair-from-the-scan-and-stay-paired,
// phase 2). The six digits are no longer displayed here: the person TYPES
// the code the asking machine is showing, which proves they can see that
// screen — the binding the comparison code was always for, enforced rather
// than trusted. Main compares; a wrong code is refused inline; the third
// wrong code declines the request. Approval and denial go through the exact
// IPC both surfaces always used, and resolution reaches every surface over
// the push channel, so no double-approve is possible.
// The scope choices, in the mockup's four combined rows: operate implies read
// within a family (shared/tailnet's own rule), so one checkbox per family
// grants the pair, and the terminal tier — arbitrary shell — stays its own
// named line, never bundled and never pre-ticked.
export const PAIR_SCOPE_ROWS = [
    { label: 'Workspaces — read & operate', scopes: ['workspace:read', 'workspace:operate'], defaultOn: true },
    { label: 'Sprints — read & operate', scopes: ['sprint:read', 'sprint:operate'], defaultOn: true },
    { label: 'Backlog — read & operate', scopes: ['backlog:read', 'backlog:operate'], defaultOn: true },
    { label: 'Terminals — control', scopes: ['terminal:observe', 'terminal:control'], note: 'arbitrary shell', defaultOn: false },
];
/** Digits only, at most six: "481 972" read off a screen is the same answer as "481972". */
export function normalizeTypedCode(value) {
    return value.replace(/\D/gu, '').slice(0, 6);
}
export function PairRequestCard({ request, now, 
/** Settings draws it flush on the page; the popover as a bordered card. */
variant = 'card', }) {
    const [granted, setGranted] = React.useState(() => new Set(PAIR_SCOPE_ROWS.filter((row) => row.defaultOn).map((row) => row.label)));
    const [code, setCode] = React.useState('');
    const [codeError, setCodeError] = React.useState(null);
    const [busy, setBusy] = React.useState(null);
    const inputId = React.useId();
    const helpId = `${inputId}-help`;
    const msLeft = Math.max(0, Date.parse(request.expiresAt) - now);
    const minutes = Math.floor(msLeft / 60_000);
    const seconds = Math.floor((msLeft % 60_000) / 1000);
    const scopes = PAIR_SCOPE_ROWS.filter((row) => granted.has(row.label)).flatMap((row) => row.scopes);
    // Settings' own rule: a lapsed request stays on screen until the channel
    // clears it, with its buttons dead and the reason stated — not failing.
    const answerable = pairRequestAnswerable(request, now);
    const disabled = busy !== null || !answerable.canAnswer;
    const asker = request.peerNode ?? request.peerAddress;
    const answer = async (kind) => {
        if (busy)
            return;
        setBusy(kind);
        try {
            if (kind === 'allow') {
                const result = await window.api.tailnetApprovePairRequest(request.id, scopes, code);
                if (!result.ok) {
                    if (result.code === 'code_mismatch') {
                        // Inline, beside the field, in the words main used: the person
                        // is mid-typing and a toast would be over their shoulder.
                        setCodeError(result.message);
                        setCode('');
                        return;
                    }
                    // `request_not_found` is an answer, not an exception — answered
                    // elsewhere or lapsed under the cursor — and swallowing it would
                    // leave a person who pressed Allow believing they had paired.
                    showToast({ tone: 'error', title: 'Could not approve the pair request', description: result.message });
                }
            }
            else
                await window.api.tailnetDenyPairRequest(request.id);
            // The push channel clears the card everywhere; nothing to do locally.
        }
        catch (error) {
            showToast({
                tone: 'error',
                title: kind === 'allow' ? 'Could not approve the pair request' : 'Could not decline the pair request',
                description: error instanceof Error ? error.message : String(error),
            });
        }
        finally {
            setBusy(null);
        }
    };
    const frame = variant === 'card'
        ? 'mx-2.5 my-1.5 rounded-[7px] border border-[color:var(--border-default)] p-2.5'
        : 'py-3 first:pt-0 last:pb-0';
    return (<div className={frame} data-pair-request={request.id}>
      <div className="flex items-center gap-2 text-meta">
        <StatusDot tone="warn" pulse label="Pair request"/>
        <span className="min-w-0 flex-1 truncate font-medium text-[color:var(--text-default)]">
          {asker} <span className="font-normal text-[color:var(--text-subtle)]">asks to pair</span>
        </span>
      </div>
      {/* Both identities, labelled: the node is what the transport proved
            (Tailscale's whois, or the bare address, unverified); the device
            name is whatever the asker typed. */}
      <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-micro">
        <dt className="text-[color:var(--text-subtle)]">{request.peerNode ? 'Tailnet node' : 'Address (unverified)'}</dt>
        <dd className="truncate font-mono text-[color:var(--text-default)]">{asker}</dd>
        <dt className="text-[color:var(--text-subtle)]">Calls itself</dt>
        <dd className="truncate text-[color:var(--text-default)]">{request.deviceName}</dd>
      </dl>
      <div className="my-2">
        <label htmlFor={inputId} className="mb-1 block text-meta text-[color:var(--text-muted)]">
          Enter the code shown on {asker}
        </label>
        <Input id={inputId} value={code} onChange={(event) => {
            setCode(normalizeTypedCode(event.target.value));
            if (codeError)
                setCodeError(null);
        }} onKeyDown={(event) => {
            if (event.key === 'Enter' && code.length === 6 && !disabled && scopes.length > 0)
                void answer('allow');
        }} inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" maxLength={6} placeholder="000000" aria-label={`Code shown on ${asker}`} aria-describedby={helpId} aria-invalid={codeError ? true : undefined} disabled={disabled} className="text-center font-mono text-title tracking-[0.3em]"/>
        <p id={helpId} className={`mt-1 text-micro ${codeError ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--text-subtle)]'}`}>
          {codeError
            ?? `Allow enables at six digits. ${PAIR_REQUEST_CODE_ATTEMPTS} wrong codes decline the request.`}
        </p>
      </div>
      <div className="flex flex-col gap-1 pb-2">
        {PAIR_SCOPE_ROWS.map((row) => (<label key={row.label} className="flex cursor-pointer items-center gap-2 text-meta text-[color:var(--text-default)]">
            <input type="checkbox" className="accent-[color:var(--accent-primary)]" checked={granted.has(row.label)} disabled={disabled} onChange={(event) => {
                setGranted((current) => {
                    const next = new Set(current);
                    if (event.target.checked)
                        next.add(row.label);
                    else
                        next.delete(row.label);
                    return next;
                });
            }}/>
            {row.label}
            {row.note ? <span className="text-[color:var(--text-subtle)]">({row.note})</span> : null}
          </label>))}
      </div>
      <div className="flex items-center gap-2">
        <span className="font-mono text-micro tabular-nums text-[color:var(--tone-warn)]">
          {answerable.canAnswer ? `${minutes}:${String(seconds).padStart(2, '0')}` : 'Lapsed'}
        </span>
        <span className="flex-1"/>
        <OutlineButton size="sm" disabled={disabled} onClick={() => void answer('decline')}>
          {busy === 'decline' ? 'Declining…' : 'Decline'}
        </OutlineButton>
        <PrimaryButton size="sm" disabled={disabled || scopes.length === 0 || code.length !== 6} onClick={() => void answer('allow')}>
          {busy === 'allow' ? 'Allowing…' : 'Allow'}
        </PrimaryButton>
      </div>
      {answerable.note ? (<p className="mt-1.5 text-micro text-[color:var(--text-subtle)]">{answerable.note}</p>) : null}
    </div>);
}
