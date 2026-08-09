'use client';

import { useState } from 'react';

import { deleteRuleAction } from '@/lib/actions/policies';

export function RemoveRuleControl({ ruleId, returnTo }: { ruleId: string; returnTo: string }) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div style={{ textAlign: 'right' }}>
        <button
          className="badge"
          style={removeTriggerStyle}
          type="button"
          title="Confirm before deleting this rule"
          onClick={() => setConfirming(true)}
        >
          remove
        </button>
      </div>
    );
  }

  return (
    <div style={removeConfirmStyle}>
      <div style={{ ...monoDim, marginBottom: 8 }}>Remove this rule?</div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="badge" type="button" title="Cancel rule deletion" onClick={() => setConfirming(false)}>
          cancel
        </button>
        <form action={deleteRuleAction}>
          <input type="hidden" name="ruleId" value={ruleId} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <button className="badge badge--warn" type="submit" title="Confirm rule deletion">
            confirm
          </button>
        </form>
      </div>
    </div>
  );
}

const removeTriggerStyle: React.CSSProperties = {
  background: 'transparent',
};

const removeConfirmStyle: React.CSSProperties = {
  padding: 10,
  border: '1px solid var(--warn)',
  background: 'var(--warn-glow)',
  minWidth: 170,
};

const monoDim: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  color: 'var(--ink-dim)',
  letterSpacing: '0.04em',
};
