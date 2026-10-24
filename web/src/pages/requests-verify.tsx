// Verification by hand: ask the authority to check a custom field or a link, and take the request
// back. The typed fields and the identity document are verified from /me now, by the verification
// service; a request made for one of them before is still listed, so that it can be taken back.
// Where each one stands comes from the chain (the profile for Verified and Rejected, the pending
// requests for Pending), never from what was clicked.
//
// A private field is checked with a verification packet, made on /me (the authority needs the
// value, which the chain never holds): the row says so as soon as a request is waiting.

import { cancelRequestCall, requestJudgementCall } from "../chain/calls.ts";
import { groupHex, LIMITS } from "../chain/edit.ts";
import type { Overview } from "../chain/overview.ts";
import { REQUEST_AUTHORITY, type VerifyItem, verifyItems } from "../chain/requests.ts";
import { State } from "./profile.tsx";
import { IconButton, XIcon } from "../ui/icons.tsx";
import { type Acting, StatusLine } from "./requests-acting.tsx";

/** What a row shows of the value: a PGP fingerprint in groups of four, a link as it is. */
function valueOf(item: VerifyItem): string | null {
  if (item.detail === null) return null;
  return item.id === "typed:Pgp" ? groupHex(item.detail) : item.detail;
}

export function VerifySection({ overview, acting }: { overview: Overview; acting: Acting }) {
  const { profile, authority, pending } = overview;
  // typed fields and the document are verified from /me: only a request already made shows here
  const items = verifyItems(profile, pending).filter((item) => item.request !== null || item.kind === "link" || item.kind === "gone" || item.id.startsWith("custom:"));
  const takes = authority !== null && authority.active;
  const full = pending.length >= LIMITS.pendingRequests;
  // what can be asked by hand here (a request kept only so that it can be cancelled does not count)
  const checkable = items.some((item) => item.kind === "link" || (item.kind === "field" && item.id.startsWith("custom:")));

  return (
    <section class="block" aria-label="Verification">
      <h2 class="section">Verification</h2>
      {authority === null && <p class="hint">No authority takes requests yet.</p>}
      {authority !== null && !authority.active && <p class="hint">{authority.name} is not taking requests right now.</p>}
      {takes && checkable && <p class="hint">Ask {authority.name} to check a custom field or a link by hand.</p>}

      <p class="hint">
        Verify your details from <a href="/me">your profile</a>.
      </p>
      {!checkable && <p class="hint">Custom fields and links are checked by hand: add one to your identity to ask for it here.</p>}

      {items.length > 0 && (
        <ul class="asks" aria-label="Verification requests">
          {items.map((item) => {
            const value = valueOf(item);
            const request = item.request;
            return (
              <li class="ask" key={item.id}>
                <div class="ask-text">
                  <span class="ask-label">{item.label}</span>
                  {item.private ? <span class="ask-value private">Private</span> : value && <span class="ask-value">{value}</span>}
                  {item.kind === "gone" && <span class="ask-value">This field is no longer on your identity.</span>}
                </div>
                <div class="ask-side">
                  {item.standing && <State standing={item.standing} />}
                  {request ? (
                    <IconButton
                      label={`Cancel the request for ${item.label}`}
                      disabled={acting.pending}
                      onClick={() => void acting.run("verify", () => cancelRequestCall(request.authority, request.target), "Request cancelled.", undefined, item.id)}
                    >
                      <XIcon />
                    </IconButton>
                  ) : (
                    item.standing !== "Verified" && (
                      <button
                        class="button small"
                        type="button"
                        aria-label={`${item.standing === "Rejected" ? "Request again" : "Request"} verification of ${item.label}`}
                        disabled={acting.pending || !takes || full}
                        onClick={() => void acting.run("verify", () => requestJudgementCall(REQUEST_AUTHORITY, item.target), "Request sent.", undefined, item.id)}
                      >
                        {item.standing === "Rejected" ? "Request again" : "Request"}
                      </button>
                    )
                  )}
                </div>
                <div class="ask-note">
                  <StatusLine acting={acting} section="verify" row={item.id} />
                </div>
                {item.private && request && (
                  <p class="hint ask-note">
                    Make its verification packet in <a href="/me">My identity</a> and send it to {authority?.name ?? "the authority"}.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {full && <p class="hint">You have reached the limit of {LIMITS.pendingRequests} pending requests.</p>}
      <StatusLine acting={acting} section="verify" rows={items.map((item) => item.id)} />
    </section>
  );
}
