export function sumUsageField(records: Array<{id:string;counters:Record<string,unknown>}>, field:string, diagnostics:string[]):number|null {
  if (records.length === 0) return null;

  let total = 0;
  let incomplete = false;

  for (const record of records) {
    const value = record.counters[field];
    if (value === undefined || value === null) {
      incomplete = true;
      continue;
    }

    if (field === 'costUsd') {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        total += value;
      } else {
        incomplete = true;
        diagnostics.push(`Field ${field} invalid for record ${record.id}`);
      }
    } else {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
        total += value;
      } else {
        incomplete = true;
        diagnostics.push(`Field ${field} invalid for record ${record.id}`);
      }
    }
  }

  if (incomplete) return null;

  if ((field === 'costUsd' && !Number.isFinite(total)) || (field !== 'costUsd' && !Number.isSafeInteger(total))) {
    diagnostics.push(`${field} overflow`);
    return null;
  }

  return total;
}