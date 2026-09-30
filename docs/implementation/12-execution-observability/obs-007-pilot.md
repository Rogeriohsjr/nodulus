## OBS007A - Handle Failure in Writing Optional telemetry.json

### Implementation Summary

The implementation ensures that when writing the optional `telemetry.json` file fails, the valid provider artifact and reported token counters are preserved. Additionally, a diagnostic containing the message 'Telemetry persistence failed' is appended to the telemetry object. This change prevents the system from repeating inference when telemetry writing fails.

### Current Status

- **Implemented Behavior**: Optional telemetry.json write isolation is implemented. The system preserves the valid provider artifact and reported token counters when writing telemetry.json fails.
- **Pending Cases**: Raw transport persistence failures, generalized trace policy, and other OBS007 cases remain pending.

### Implementation Changes

- Modified `src/adapters/providers/captured-process.ts` to handle errors during writing `telemetry.json`.
- Appended diagnostics containing 'Telemetry persistence failed' to the telemetry object.
- Ensured provider artifact preservation even when telemetry writing fails.

### Testing

- **Test File**: `tests/scenarios/obs-007-telemetry-write-isolation.test.ts`
- **Expected Result**: The test verifies that the system does not reject a valid provider artifact and does not repeat inference when writing telemetry.json fails.
- **Check IDs**: `obs007`

### Next Steps

- Continue implementing and testing the remaining pending cases as defined in OBS007.
- Ensure that all related documentation and user guides are updated to reflect the changes.
