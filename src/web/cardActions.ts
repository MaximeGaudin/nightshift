/** Awaits an action; a failure is reported through `onError` and gives false, so callers only go on after a success. */
export async function attempt(action: Promise<unknown>, onError: (message: string) => void): Promise<boolean> {
  try {
    await action;
    return true;
  } catch (e) {
    onError(e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** Deletes, then closes: a failed delete leaves the card open with its error visible. */
export async function deleteThenClose(del: Promise<unknown>, close: () => void, onError: (message: string) => void) {
  if (await attempt(del, onError)) close();
}

/** Sends the answers, then clears the form: a failed send keeps what the user typed. */
export async function sendThenClear(send: Promise<unknown>, clear: () => void, onError: (message: string) => void) {
  if (await attempt(send, onError)) clear();
}
