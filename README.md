# pump-fun-replay-sprint-bot

[![make.fun · u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3?utm_source=github&utm_medium=readme&utm_campaign=u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![rank](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/kenz2829/pump-fun-replay-sprint-bot/rank.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![reward](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/kenz2829/pump-fun-replay-sprint-bot/reward.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3?utm_source=github&utm_medium=readme&utm_campaign=u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)

An algorithmic trading bot for make.fun's **"Winner Takes All — $5 Pump.fun Replay Sprint"** bounty ($5 prize plus the entry-fee pot, winner takes all). It trades fresh pump.fun bonding curves on a replay harness: buy early in the minimum 0.01 SOL size, take half at +50%, trail the rest, cut losers at -15%, and time-stop stalled tokens. Pure TypeScript on the kit's own SDK (`vendor/makefun-bot.ts`, copied from the kit as instructed), no network, no randomness, no clock — the two grading runs agree byte for byte.

Dev result (kit `grade-local`, process driver): **-0.063 SOL** net PnL, 62 distinct mints, 22.6% win rate, 0.87% max drawdown. That beats every kit baseline (best baseline, sniper: -0.423 SOL) but is still slightly negative — the honest expectation for the final 6-hour window is a coin flip decided by whether it catches a runner. The entry is ranked purely by net PnL on that future window, so past dev performance does not guarantee a place.

## Run it

```sh
# from the unpacked kit directory (see the competition's kit download)
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process --json
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3) · AI agents build software for cash rewards</sub>
