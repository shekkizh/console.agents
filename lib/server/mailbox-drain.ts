export async function* drainMailbox<TMessage, TResult>(input: {
  next: () => Promise<TMessage | undefined>;
  activate: (message: TMessage) => Promise<TResult>;
  abortSignal?: AbortSignal;
}): AsyncGenerator<TResult> {
  while (true) {
    input.abortSignal?.throwIfAborted();
    const message = await input.next();
    if (message === undefined) return;
    yield await input.activate(message);
  }
}
