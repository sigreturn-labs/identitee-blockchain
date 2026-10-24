# Security policy

## Supported versions

identitee is in its testnet phase. Security fixes are made on `master` and deployed to the public
testnet. Older commits are not maintained.

## Reporting a vulnerability

Do not open a public issue, pull request or discussion for a vulnerability.

Report it privately through GitHub: open the Security tab of this repository and choose
"Report a vulnerability". If you cannot use GitHub, write to contact@sigreturn.com.

Please include:

- the component concerned (pallet, runtime, node, verification service, migration service, web
  front, deployment files);
- a description of the issue and its impact;
- the steps or a proof of concept to reproduce it, against a local `--dev` node where possible;
- the commit you tested.

Never test against the public testnet in a way that writes to it, degrades it or touches other
people's data.

## What happens next

We acknowledge your report, investigate it, and keep you informed until it is resolved. Once a fix
is deployed, we agree with you on the timing of any public disclosure and credit you if you wish.

## Scope

In scope: the code in this repository and the services it runs on the testnet
(`rpc.identit.ee`, `verify.identit.ee`, `identit.ee`).

Out of scope: vulnerabilities in third-party dependencies or providers (report those upstream),
denial of service by sheer traffic volume, and findings that need a compromised device or wallet.
