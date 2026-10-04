'use client';

import { useCallback, useEffect, useState } from 'react';

import type { BalanceResponse } from '../app/api/balance/route.ts';
import { DEFAULT_NETWORK, type NetworkId } from './deployments.ts';
import { SOLO_HUMANOS } from './human-gate-ui';
import { BALANCE } from './mode-copy.ts';

export interface Balances {
  data: BalanceResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Polls every ten seconds while the tab is in front.
 *
 * It used to poll nothing, and the argument was good: balances change when the
 * user does something, funding and paying both call `refresh()`, and a timer
 * would spend requests to say the same number forty times. What broke it is
 * that the most important change to this number is one the user makes
 * *somewhere else* — they send USDC from an exchange or another wallet, and
 * the app finds out only when the ledger does. There was a refresh button for
 * exactly that, and asking somebody to press a button until their money shows
 * up is asking them to do the polling by hand.
 *
 * Ten seconds because devnet confirms in well under that, and a public RPC
 * rate-limits anything much faster. Only while `visibilityState` is `visible`, and a read fires on the
 * way back to visible: a shopper who switched to their exchange app to send
 * the money is the exact person who needs the number to be right when they
 * switch back, and a background tab is the exact one that should not be
 * spending requests.
 *
 * Polls are quiet — they do not touch `loading`, so nothing on screen blinks
 * every ten seconds — and a failed poll keeps the last good number rather than
 * blanking it. One bad answer out of a request every ten seconds is a hiccup,
 * not news, and a balance that flickers to `-` and back is worse than a
 * slightly stale one. The error line still appears, so the shopper is told.
 *
 * Keyed on the network as well as the address, because the same wallet holds
 * different money on each chain. It is in the dep array, which is the whole
 * fix: flipping the mode drops the old number and refetches rather than
 * leaving one chain's balance on screen under the other one's label.
 *
 * ## One network
 * Only devnet exists now. The `network` parameter stays because it costs one
 * query string and keeps chains out of a hook that has no opinion about them.
 *
 * ## `error` is copy, never a message from somewhere else
 *
 * It is rendered verbatim beside the balance, so everything that reaches it
 * has to be written for a shopper. It was not: the hook parsed the body
 * before looking at the status, threw whatever the server or the JSON parser
 * said, and painted that. A route's own 502 put `could not read balances:
 * Invalid contract ID:` on screen; a gateway's HTML error page put
 * `Unexpected token '<', "<!DOCTYPE "…` there, which is what a signed-in
 * shopper actually saw.
 *
 * Both are now one Spanish line, and the detail goes to the console, where
 * whoever is debugging can find it and nobody else has to read it.
 */
/** Long enough not to be a load, short enough to be "the next ledger or so". */
const POLL_MS = 10_000;

export function useBalances(address: string | null, network: NetworkId = DEFAULT_NETWORK): Balances {
  const [data, setData] = useState<BalanceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // Its own effect, before the fetch, so it does *not* run on `refresh()`.
  // A wallet that just funded should watch its number change, not blink to
  // empty; a wallet that changed network is showing a number that is now
  // simply wrong, and the wrong number must go before the request, not when
  // the answer lands.
  useEffect(() => {
    setData(null);
    setError(null);
  }, [address, network]);

  // The read itself, shared by the first one and every poll. `quiet` is the
  // only difference: a poll must not raise `loading`, or anything bound to it
  // flickers on a ten-second beat.
  const read = useCallback(
    (quiet: boolean, cancelled: () => boolean) => {
      if (!quiet) setLoading(true);
      return fetch(
        `/api/balance?address=${encodeURIComponent(address ?? '')}&network=${encodeURIComponent(network)}`,
      )
        .then(async (res) => {
          // Status first, body second. A lambda that crashed or a gateway that
          // timed out answers with an HTML error page, and parsing that throws
          // before there is anything to check — which is how the parser's own
          // complaint ended up being the error the shopper read.
          const json = (await res.json().catch(() => null)) as
            | (Partial<BalanceResponse> & { error?: string; message?: string })
            | null;
          if (cancelled()) return;
          if (!res.ok || !json) {
            // The human gate already explains this. The raw code `solo_humanos`
            // was showing up in red inside the wallet.
            if (json?.error === SOLO_HUMANOS) {
              setData(null);
              setError(null);
              return;
            }
            console.warn('[balance] read failed:', res.status, json?.error ?? json?.message ?? '(unparseable body)');
            // `data` is left alone. The effect below clears it when the wallet
            // or the network changes, which is the case where the old number
            // is *wrong*; a failed read only means we do not know a newer one.
            setError(BALANCE.unavailable);
            return;
          }
          setData(json as BalanceResponse);
          setError(null);
        })
        .catch((err: unknown) => {
          if (cancelled()) return;
          // The browser's own text is English and names nothing anybody can act
          // on, so it goes to the console and the shopper gets the same line as
          // every other way this read can fail.
          console.warn('[balance] request failed:', err);
          setError(BALANCE.unavailable);
        })
        .finally(() => {
          if (!cancelled() && !quiet) setLoading(false);
        });
    },
    [address, network],
  );

  useEffect(() => {
    if (!address) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const gone = () => cancelled;

    void read(false, gone);

    // `setInterval` and not a chained `setTimeout`: a read that hangs must not
    // stop the next one from being attempted, and each read cancels itself on
    // unmount anyway.
    let timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void read(true, gone);
    }, POLL_MS);

    // Coming back to the tab is the moment the number is most likely to be
    // stale — somebody just left to send money — so it does not wait out the
    // rest of the interval. The timer restarts from here too, so the next poll
    // is a full interval after this read rather than immediately behind it.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void read(true, gone);
      window.clearInterval(timer);
      timer = window.setInterval(() => {
        if (document.visibilityState === 'visible') void read(true, gone);
      }, POLL_MS);
    };
    document.addEventListener('visibilitychange', onVisible);

    // A logout mid-flight must not write the old wallet's balance into the new
    // wallet's widget.
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [address, network, nonce, read]);

  return { data, loading, error, refresh };
}
