Raw JSON of the IdentiteeApi runtime API responses from a node `target/release/identitee-node --dev
--tmp` (an earlier runtime; the shapes are unchanged), after these real transactions (dev keys; Alice is the agent of
authority 0):

  user    set_identity (DisplayName, public Email, private Telegram, Pgp, free-form field "mastodon"),
          set_bio, add_link x2, set_avatar (pallets/identitee/tests/fixtures/avatar-64-lossy.webp),
          request_judgement(authority 0, Email); Alice: provide_judgement(Email, Verified,
          EmailCode) and grant_fact(DocumentChecked); user: claim_username("fixtureuser")
  parent  set_bio, add_sub(user, "main laptop"), add_sub(eve, "phone"); user: accept_sub(parent)
  eve     set_identity(Email), Alice: provide_judgement(Email, Verified, Manual);
          eve: claim_username("evename") then release_username (the name is therefore in quarantine);
          Alice: reserve_username("reservedname")

profile-*.json    IdentiteeApi.profile(account)
names.json        IdentiteeApi.name_status(name) for each of the five states
subs-parent.json  IdentiteeApi.subs_of and pending_subs_of of the parent, and the entries of the
                  subProposals table under eve's key (the key lists [sub, parent])

The addresses are those of the `//F2User`, `//F2Parent` and `//F2Eve` keys of the dev keyring.

requests.json     Raw JSON read back from a dev node after request_judgement on an
                  email, a free-form field, a link and the DocumentChecked fact (authority 0), a
                  request_migration, and a fulfil_migration by the MIGRATE agent (Bob). `pending` is the
                  entries of the pendingRequests table under one account (the key is [authority, target],
                  the value the block), `authority` the entry 0 of the authorities table, `migrationPending`
                  the migrationRequests entry, `history` the importedHistory entry. A refused migration
                  leaves nothing in storage (only the MigrationRejected event).
