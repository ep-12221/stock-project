import type { AccountStateDto } from '@stock/shared';
import { defineStore } from 'pinia';
import { ref } from 'vue';
export interface AccountOwner {
  userId: string;
  serverEpoch: string;
}
export const useAccountStore = defineStore('account', () => {
  const snapshot = ref<AccountStateDto | null>(null);
  function applySnapshot(next: AccountStateDto, owner: AccountOwner): boolean {
    if (next.userId !== owner.userId || next.serverEpoch !== owner.serverEpoch) return false;
    if (!Number.isSafeInteger(next.accountVersion) || next.accountVersion < 0) return false;
    const current = snapshot.value;
    if (
      current?.userId === owner.userId &&
      current.serverEpoch === owner.serverEpoch &&
      current.accountVersion >= next.accountVersion
    )
      return false;
    snapshot.value = next;
    return true;
  }
  function reset() {
    snapshot.value = null;
  }
  return { snapshot, applySnapshot, reset };
});
