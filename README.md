# gta6-trophy-rarity-forecast-01

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/zhfz-ai/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/zhfz-ai/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Dilution-aware trophy earn-rate forecaster: earner/pool decomposition with saturation caps. An Exophase earn rate is earners divided by tracked players, and after a launch the two sides move at different speeds — the tracked pool floods in and dilutes every rate, while earners accumulate as players progress and lift story trophies toward a ceiling. The program forecasts both forces from the distinct refreshes inside each case's history, blends them with persistence in logit space, enforces story-chain monotonicity (a later chapter's earners are a subset of the earlier one's), and sets its spread from a random-walk floor, walk-forward refresh volatility, and a refresh-jump term for a page that has not refreshed lately. Deterministic, offline, Node 22 standard library only. Model selection is documented in JUDGE-SCORECARD.md.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=ygzr8d2m&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
