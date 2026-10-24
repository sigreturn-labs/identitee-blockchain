//! The pallets benchmarked by `identitee-node benchmark pallet`. The identitee pallet is not
//! among them: its weights are written by hand (`pallet_identitee::weights`).

frame_benchmarking::define_benchmarks!(
	[frame_benchmarking, BaselineBench::<Runtime>]
	[frame_system, SystemBench::<Runtime>]
	[frame_system_extensions, SystemExtensionsBench::<Runtime>]
	[pallet_balances, Balances]
	[pallet_timestamp, Timestamp]
	[pallet_sudo, Sudo]
);
