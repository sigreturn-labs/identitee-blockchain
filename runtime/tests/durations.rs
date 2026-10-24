//! The durations the runtime gives the pallet are lengths of time, not block counts: they must
//! stay right if the block time changes.

use frame_support::traits::Get;
use identitee_runtime::{Runtime, MILLI_SECS_PER_BLOCK};

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

fn millis(blocks: u32) -> u64 {
	u64::from(blocks) * MILLI_SECS_PER_BLOCK
}

#[test]
fn quota_window_is_one_day() {
	let window = <Runtime as pallet_identitee::Config>::QuotaWindow::get();
	assert_eq!(millis(window), DAY_MS);
}

#[test]
fn name_quarantine_is_thirty_days() {
	let quarantine = <Runtime as pallet_identitee::Config>::NameQuarantine::get();
	assert_eq!(millis(quarantine), 30 * DAY_MS);
}
