# DID method: format and planned mapping

Each account has one decentralized identifier, `did:identitee:<ss58>`. Resolution into a DID document
and export as Verifiable Credentials are meant to happen off-chain, from the runtime API. Only the
format is defined here: no resolver, resolution service or credential signing exists yet.

## Syntax

```
did:identitee:<SS58 address with prefix 2426>
```

- `method-name` is `identitee`.
- `method-specific-id` is the account's `AccountId32`, encoded in SS58 with prefix 2426 (the chain's
  prefix, `system.properties.ss58Format`). Example, the testnet migration agent:
  `did:identitee:idondCKcoqPNnUS5uXAAULjmW9W1oWfHRG7dxV48im12JG7UG`.
- Canonical form: a resolver accepts an SS58 address of any prefix or the key in hexadecimal (`0x`
  and 64 digits), but produces only the prefix 2426 form. Two DIDs that designate the same
  `AccountId32` are the same subject.
- No path or query is defined.

### Network

The testnet can be reset (new genesis), so a testnet DID designates nothing stable. Before a public
launch, networks must be told apart, either in the identifier (`did:identitee:testnet:<ss58>`, the short
form kept for the main network) or by the genesis hash in the document. The document below always
carries the genesis hash.

## DID document (planned resolution)

Built from `identiteeApi.profile(account)` read at a finalized block. An account without an identity
(`profile` is `None`) has no document: resolution returns `notFound`.

```json
{
  "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/blockchain-2021/v1"],
  "id": "did:identitee:id...",
  "verificationMethod": [{
    "id": "did:identitee:id...#account",
    "type": "BlockchainVerificationMethod2021",
    "controller": "did:identitee:id...",
    "blockchainAccountId": "polkadot:<first 32 hex characters of the genesis hash>:id..."
  }],
  "authentication": ["did:identitee:id...#account"],
  "assertionMethod": ["did:identitee:id...#account"],
  "alsoKnownAs": ["identitee:name:alice", "https://example.org"],
  "controller": "did:identitee:<parent>"
}
```

| Document element | Source on chain | Note |
|---|---|---|
| `id` | The account | Canonical form, see Syntax |
| `verificationMethod` | The account | CAIP-10 (`polkadot:<first 32 hex characters of the genesis hash>:<address>`) rather than a key: an `AccountId32` does not say whether the key is sr25519, ed25519 or a hashed ecdsa key, so no `publicKeyMultibase` is published |
| `alsoKnownAs` | `profile.name` (the native name), then the links of `identity.links` with a valid attestation | An unattested link is left out: `alsoKnownAs` asserts an equivalence |
| `controller` | `profile.parent` (accepted sub-account link) | Absent otherwise. A parent does not control the sub-account's keys; whether `controller` is the right term for the link is still open |
| Resolution metadata | Number and hash of the block read, `trustLevel` | `didDocumentMetadata.versionId` is the block hash |
| `service` | None | Not defined |

Fields (email, Telegram, ...), the bio and the avatar stay out of the DID document: a document is
meant to be copied everywhere, while a field can change or be private. They are exported as credentials
instead, which carry their proof and status.

`deactivated: true` marks an identity that was cleared (`clear_identity`) while facts or a migration
history remain.

## Verifiable Credentials (planned export)

One credential per valid attestation and per active fact of `profile`, plus one for the trust level,
following the W3C VC Data Model 2.0.

| Credential | Source | `credentialSubject` |
|---|---|---|
| `IdentiteeFieldAttestation` | `profile.attestations[i]` with `valid = true` | `id` (DID), `field` (`Typed Email`, `Custom pronouns`, `Link 0`), `commitment` (H256), `value` only if the field is public, `verdict`, `method` |
| `IdentiteeFact` | Active `profile.facts[i]` | `id`, `kind` (`DocumentChecked`, `Fraud`), `reason`; never data from the checked document, which is not on chain |
| `IdentiteeTrustLevel` | `profile.trustLevel` | `id`, `level` |
| `IdentiteeMigration` | `profile.imported` | `id`, `source`, `block`, `blockHash`, `judgements` |

- Issuer: the authority, not its agent. `issuer` is `did:identitee:authority:<AuthorityId>`, a reserved
  sub-namespace resolved to `{ name, active }` from `identitee.authorities`. The agent that signed the
  extrinsic appears in `evidence`.
- Proof: the chain is the source of truth. `evidence` cites the block and the event
  (`identitee.FieldAttested` or `FactGranted`, block number, extrinsic index). A `DataIntegrityProof`
  signature, if any, would be the export service's and would only attest that it read the chain.
- Status: `credentialStatus` of type `IdentiteeOnChainStatus` means "read `profile` again at the latest
  finalized block". A credential whose attestation is revoked, expired or whose value has changed
  (`valid = false`) is revoked by construction, so an attestation never stays displayed as verified
  after its value changed.
- Private field: the credential carries only the commitment. The person discloses the value and its
  salt; the verifier recomputes `blake2_256("identitee:field:private:v1" ‖ salt ‖ value)` and compares
  it with `commitment`. This is selective disclosure without publishing anything.
- `validFrom` is the timestamp of the attestation block; `validUntil` is `expires_at` converted to a date
  (6 s blocks), when set.

## Not yet built

- A resolver, as a library or an HTTP service (`/1.0/identifiers/did:identitee:...`, in the style of
  the Universal Resolver).
- Signed credential export.
- Registration of the `identitee` method in the W3C DID method registry.
- The choice of the network format (see Network).
