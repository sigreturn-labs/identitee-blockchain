import type { ComponentChildren } from "preact";
import { PROFILE_BASE } from "../api.ts";

// `/docs`: the extrinsics that matter on identitee, who may send them and how, for people, authority
// agents and the operator. Static: nothing here is read from the API.

const APPS = "https://polkadot.js.org/apps/?rpc=wss%3A%2F%2Frpc.identit.ee#/extrinsics";
const PUBLIC_TAG = "0x6964656e74697465653a6669656c643a7075626c69633a7631";

const C = ({ children }: { children: ComponentChildren }) => <code class="x-code">{children}</code>;

type Call = [call: string, args: string, effect: ComponentChildren];

function Calls({ label, rows }: { label: string; rows: Call[] }) {
  return (
    <div class="x-scroll">
      <table class="x-table x-doc-table" aria-label={label}>
        <thead>
          <tr>
            <th>Call</th>
            <th>Arguments</th>
            <th>Effect</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([call, args, effect]) => (
            <tr key={call}>
              <td>
                <C>{call}</C>
              </td>
              <td>{args && <C>{args}</C>}</td>
              <td>{effect}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Part({ id, title, children }: { id: string; title: string; children: ComponentChildren }) {
  return (
    <section class="x-section x-doc" id={id} aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

const CONTENTS: Array<[id: string, title: string]> = [
  ["sending", "Sending an extrinsic"],
  ["authorities", "Authorities and agents"],
  ["adding", "Adding an authority or an agent"],
  ["attesting", "Attesting a field"],
  ["facts", "Facts about a person"],
  ["names", "Usernames"],
  ["people", "Calls for everyone"],
  ["validators", "Validators"],
  ["reading", "Reading the result"],
];

export function Docs() {
  return (
    <section class="x-page x-docs">
      <h1>Extrinsics</h1>
      <p class="note">
        Every write to identitee is an extrinsic of the <C>identitee</C> pallet. This page lists the ones that matter, who may send them, and how to
        send them by hand.
      </p>
      <nav class="x-toc" aria-label="Contents">
        {CONTENTS.map(([id, title]) => (
          <a key={id} href={`#${id}`}>
            {title}
          </a>
        ))}
      </nav>

      <Part id="sending" title="Sending an extrinsic">
        <p>
          Open <a href={APPS}>polkadot.js/apps on the testnet</a>, then Developer, Extrinsics. Choose the account that signs, the module{" "}
          <C>identitee</C> and the call. Update the chain metadata in your wallet extension once, so that it can show what it signs.
        </p>
        <p>
          An address can be pasted in any SS58 form: <C>5Grw…</C> and <C>id…</C> are the same key, and identitee shows it with prefix 2426, starting with{" "}
          <C>id</C>.
        </p>
        <p>Three kinds of signer exist:</p>
        <ul>
          <li>
            <strong>Root</strong>: the sudo key. Its calls go through Developer, Sudo, with the <C>identitee</C> call inside <C>sudo(call)</C>.
          </li>
          <li>
            <strong>Agents</strong>: accounts that act for an authority, within the capabilities they hold. Their calls are free.
          </li>
          <li>
            <strong>Everyone</strong>: a person writing their own identity. These calls are free too, within 50 calls per account per day.
          </li>
        </ul>
      </Part>

      <Part id="authorities" title="Authorities and agents">
        <p>
          An authority is an organisation that checks identities: a name and a number, with no account of its own. It acts through agents, the
          accounts that sign for it. Each agent serves one authority and holds capabilities, added up as bits.
        </p>
        <div class="x-scroll">
          <table class="x-table x-doc-table" aria-label="Capabilities">
            <thead>
              <tr>
                <th>Bit</th>
                <th>Capability</th>
                <th>Allows</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>1</td>
                <td>Attest fields</td>
                <td>
                  <C>provideJudgement</C>, <C>revokeAttestation</C>, refusing field requests
                </td>
              </tr>
              <tr>
                <td>2</td>
                <td>Person facts</td>
                <td>
                  <C>grantFact</C>, <C>revokeFact</C>, refusing fact requests
                </td>
              </tr>
              <tr>
                <td>4</td>
                <td>Manage names</td>
                <td>
                  <C>reserveUsername</C>, <C>unreserveUsername</C>, <C>setUsernameFor</C>, <C>unbindUsername</C>
                </td>
              </tr>
              <tr>
                <td>8</td>
                <td>Migrate</td>
                <td>
                  <C>fulfilMigration</C>, <C>rejectMigration</C>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          A verifier usually gets <C>3</C> (attest fields and person facts). <C>15</C> gives everything.
        </p>
        <p>These calls are Root only:</p>
        <Calls
          label="Root calls"
          rows={[
            ["addAuthority", "name", "Registers an authority, active, under the next free id. Ids start at 0 and are never reused; 16 at most."],
            ["setAgent", "authority, agent, caps", "Makes an account an agent of the authority, or changes its capabilities there."],
            ["removeAgent", "agent", "The account is no longer an agent."],
            ["setAuthorityActive", "authority, active", "Switches an authority off or on. The agents of an inactive authority cannot act."],
            ["killIdentity", "who", "Deletes an identity with its facts, migration history and identity secret."],
          ]}
        />
      </Part>

      <Part id="adding" title="Adding an authority or an agent">
        <p>
          <C>addAuthority</C> takes a name only. The wallet address of the person who will act goes in <C>setAgent</C>.
        </p>
        <p>
          <strong>A new agent for an existing authority</strong>, for example authority 0, identitee:
        </p>
        <pre class="x-pre">sudo(identitee.setAgent(0, &lt;address&gt;, 3))</pre>
        <p>
          <strong>A new organisation with its own agent</strong>, in two steps. Check on <a href="/authorities">Authorities</a> which id the new
          authority received before the second one.
        </p>
        <pre class="x-pre">{"sudo(identitee.addAuthority(\"Example Org\"))\nsudo(identitee.setAgent(1, <address>, 3))"}</pre>
        <p>
          An account that already serves an authority cannot serve a second one: remove it first with <C>removeAgent</C>. The agent needs no tokens.
        </p>
      </Part>

      <Part id="attesting" title="Attesting a field">
        <p>
          The simplest way is the authority page of identit.ee, <a href={`${PROFILE_BASE.replace(/\/$/, "")}/authority`}>identit.ee/authority</a>,
          opened with the agent's wallet. It lists the requests waiting for the authority, checks private values against their verification
          packet, and signs the right call. By hand, the call is:
        </p>
        <pre class="x-pre">provideJudgement(who, key, expectedCommitment, verdict, method, expiresAt)</pre>
        <ul>
          <li>
            <C>who</C>: the person's address. <C>key</C>: the field, for example <C>Typed / Email</C>, <C>Custom("city")</C> or <C>Link(0)</C>.
          </li>
          <li>
            <C>expectedCommitment</C>: the commitment of the value you checked. If the field changed since, the call fails with{" "}
            <C>StaleCommitment</C>, so a value you did not see is never attested.
          </li>
          <li>
            <C>verdict</C>: <C>Verified</C>, or <C>Rejected</C> for a value checked and refused, such as a disposable email. A rejected field counts as
            not verified.
          </li>
          <li>
            <C>method</C>: <C>EmailCode</C>, <C>OAuth</C>, <C>MatrixChallenge</C>, <C>PgpSignature</C>, <C>Dns</C>, <C>WebFile</C>, <C>Manual</C> or{" "}
            <C>BotChallenge</C>.
          </li>
          <li>
            <C>expiresAt</C>: a future block number, or <C>None</C>.
          </li>
        </ul>
        <p>Finding the commitment: Developer, Runtime calls, <C>identiteeApi.profile(who)</C>, then the field under <C>identity</C>.</p>
        <ul>
          <li>
            <C>Private: 0x…</C>: that value is the commitment.
          </li>
          <li>
            <C>Public: 0x…</C>: hash it in Developer, Utilities, Hash, with blake2 at 256 bits, the input being <C>{PUBLIC_TAG}</C> followed by the
            value's hexadecimal without its <C>0x</C>.
          </li>
        </ul>
        <p>
          A link's commitment covers its title and address encoded together: use identit.ee/authority for links. Attesting again replaces the
          authority's previous attestation of that field. Changing a field invalidates its attestations; setting the same value back makes them
          valid again.
        </p>
        <Calls
          label="Agent calls on fields"
          rows={[
            ["provideJudgement", "who, key, expectedCommitment, verdict, method, expiresAt", "Records the verdict and consumes the matching request."],
            ["revokeAttestation", "who, key, reason", "Revokes the authority's attestation of that field."],
            ["rejectRequest", "who, target, reason, note", "Dismisses a request without recording anything on the identity. The note holds 128 bytes."],
          ]}
        />
        <p>
          Reasons: <C>Unspecified</C>, <C>ValueMismatch</C>, <C>Disposable</C>, <C>Impersonation</C>, <C>DocumentInvalid</C>, <C>UserRequest</C>,{" "}
          <C>Abuse</C>, <C>Other</C>.
        </p>
      </Part>

      <Part id="facts" title="Facts about a person">
        <p>
          A fact concerns the person, not a field: <C>DocumentChecked</C> (an identity document was checked) or <C>Fraud</C>. Facts survive when the
          person clears their identity. A <C>Fraud</C> fact from any authority makes the identity Fraudulent.
        </p>
        <Calls
          label="Agent calls on facts"
          rows={[
            ["grantFact", "who, kind, expiresAt, reason, note", "Records the fact, replacing the authority's previous fact of that kind."],
            ["revokeFact", "who, kind, reason", "Revokes it."],
          ]}
        />
        <p>
          Trust levels follow: Partially Verified with one verified field, Fully Verified when every verifiable typed field is verified (display and
          legal names do not count), Certified with a <C>DocumentChecked</C> fact on top.
        </p>
      </Part>

      <Part id="names" title="Usernames">
        <p>Root, or an agent holding manage names:</p>
        <Calls
          label="Name management calls"
          rows={[
            ["reserveUsername", "name", "Nobody can claim the name; only a manager can give it."],
            ["unreserveUsername", "name", "Lifts the reservation."],
            ["setUsernameFor", "who, name", "Gives a name to an account with an identity and no name. Never past the 30 day quarantine."],
            ["unbindUsername", "who, reason", "Takes a name away; it goes into quarantine for 30 days."],
          ]}
        />
      </Part>

      <Part id="people" title="Calls for everyone">
        <p>Signed by the person for their own account, free within the daily quota. identit.ee sends them for you.</p>
        <Calls
          label="Calls for everyone"
          rows={[
            ["setField", "key, value", "Sets a field, Public(bytes) or Private(commitment), creating the identity if needed."],
            ["setIdentity", "changes", "Up to 32 field changes in one transaction."],
            ["updateProfile", "update", "Bio, avatar, fields and links in one transaction."],
            ["requestJudgement", "authority, target", "Asks an authority to check a field or record a fact. 16 pending requests at most."],
            ["cancelRequest", "authority, target", "Withdraws the request."],
            ["revealField", "key, value, salt", "Makes a private field public; its attestations stay valid."],
            ["claimUsername", "name", "Needs a verified field. 3 to 32 characters of a-z, 0-9, - and _."],
            ["releaseUsername", "", "Gives the name up."],
            ["addSub", "sub, label", "Proposes an account as a sub-account; it is linked once it accepts."],
            ["acceptSub", "parent", "Accepts a proposal."],
            ["requestMigration", "source", "Brings an identity over from the Polkadot or Kusama People Chain, once."],
            ["clearIdentity", "", "Deletes the identity. Facts recorded by authorities stay."],
          ]}
        />
      </Part>

      <Part id="validators" title="Validators">
        <p>
          Validators produce and finalize the blocks. Each is an account with two session keys held by its node: an Aura key (sr25519) and a
          GRANDPA key (ed25519). The set is managed by root and changes at session boundaries, every 10 minutes: a validator added or removed
          takes part, or stops, at the start of the session after next, so within 20 minutes. The <a href="/network">Network</a> page shows the
          current set.
        </p>
        <p>
          <strong>Adding a validator.</strong> Its operator runs a node with <C>--validator</C>, generates the keys with <C>author_rotateKeys</C> on
          that node's own RPC, and sends the account address and the two public keys. Then:
        </p>
        <pre class="x-pre">{"sudo(validators.addValidator(<address>, { aura: <0x aura key>, grandpa: <0x grandpa key> }))"}</pre>
        <p>
          The account needs no tokens and no proof: root vouches for the keys. GRANDPA needs more than two thirds of the validators online to
          finalize, so with two validators both must be up; blocks keep coming without them, finality waits.
        </p>
        <Calls
          label="Validator set calls"
          rows={[
            ["addValidator", "who, keys", "Adds the account with its Aura and GRANDPA keys. A key already registered to another account is refused."],
            ["removeValidator", "who", "Removes the account from the set. The last validator cannot be removed."],
          ]}
        />
        <Calls
          label="Calls of a validator"
          rows={[
            ["session.setKeys", "keys, proof", "Rotates the validator's own keys; the proof comes from author_rotateKeysWithOwner on its node."],
            ["session.purgeKeys", "", "Clears its keys; it stops validating from the session after next."],
          ]}
        />
      </Part>

      <Part id="reading" title="Reading the result">
        <ul>
          <li>
            The explorer: <a href="/authorities">Authorities</a> lists every authority with its agents and capabilities,{" "}
            <a href="/attestations">Attestations</a> every verdict, and each account page its roles and history.
          </li>
          <li>
            Developer, Chain state: <C>identitee.agents(address)</C> gives the authority and capabilities of an agent, <C>identitee.authorities(id)</C>{" "}
            an authority's name and status.
          </li>
          <li>
            Developer, Runtime calls: <C>identiteeApi.profile(address)</C> gives the identity, its trust level, its attestations with their validity
            now, and its facts.
          </li>
        </ul>
      </Part>
    </section>
  );
}
