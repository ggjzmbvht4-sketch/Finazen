# Quant-Analytik in Finazen (Port von gs-quant)

Finazen ist eine reine JavaScript-App (ES-Module, kein Build-Schritt). Das Python-Repo
[gs-quant](https://github.com/goldmansachs/gs-quant) (Goldman Sachs, Apache-2.0-Lizenz) kann daher
nicht direkt importiert werden — die relevanten Funktionen sind stattdessen 1:1 nach JavaScript
portiert in **`quant.js`**. Dieses Dokument erklärt, welche gs-quant-Funktion wo umgesetzt ist und
wie die Formeln funktionieren.

## Datenfluss

```
portfolio.snapshots  ({date, value (EUR-Cents), benchmarkName, benchmarkMicros, ...})
        │  sortieren nach Datum, Werte als {date, value}-Serie
        ▼
quant.js: returns() ──► einfache/log/absolute Renditen zwischen zwei Ständen
        │
        ▼
quant.js: portfolioRisk(snapshots) ──► Kennzahlen-Objekt
        │
        ▼
portfolio-ui.js: riskSection() ──► Kachel „Risikokennzahlen" im Verlauf (Portfolio-Seite)
```

Alle Quoten in `quant.js` sind **Brüche** (`0.2` = 20 %). Die UI multipliziert für die Anzeige
mit 100 und nutzt die vorhandenen Formatierer `pct()` / `money()`.

## Mapping gs-quant → quant.js

| gs-quant (Python) | quant.js (JavaScript) | Formel |
|---|---|---|
| `gs_quant.timeseries.econometrics.returns` | `returns(series, type)` | simple: `V_t / V_{t-1} − 1`; log: `ln(V_t / V_{t-1})`; absolute: `V_t − V_{t-1}` |
| `gs_quant.timeseries.statistics.mean / std / var` | `mean`, `std`, `variance` | Stichproben-Standardabweichung mit `N−1` (ddof=1) |
| `gs_quant.timeseries.measures_reports.skewness / kurtosis` (scipy `bias=False`) | `skewness`, `kurtosis` | bias-korrigierte Momente: `G1 = √(n(n−1))/(n−2) · m3/m2^1,5`, `G2 = (n−1)/((n−2)(n−3)) · ((n+1)·g2 + 6)` (Fisher) |
| `gs_quant.timeseries.econometrics._get_annualization_factor` | `annualizationFactor(dates)` | mittlerer Beobachtungsabstand in Tagen → Faktor: <2,1 → 252 (täglich), 6–8 → 52, 14–17 → 26, 25–35 → 12, 85–97 → 4, 360–386 → 1. In gs-quant führen Lücken zwischen den Bändern zu einem Fehler; hier wird das nächste Band gewählt (Tagesstände werden unregelmäßig gespeichert) |
| `gs_quant.timeseries.econometrics._annualized_return` | `annualizedReturn(series)` | `(V_end / V_start)^(365,25 / Tage) − 1` |
| `gs_quant.timeseries.econometrics.volatility` | `volatility(series, {assumeZeroMean})` | `std(Renditen) · √Faktor`; mit `assumeZeroMean` RMS mit `N` statt `N−1` (wie bei Variance-Swaps in gs-quant) |
| `gs_quant.timeseries.econometrics.max_drawdown` | `maxDrawdown(series)` | kleinstes `V_t / bisheriges Maximum − 1` (negativer Bruch, z. B. `−0.2` = −20 %) |
| `gs_quant.timeseries.measures_reports.realized_var` | `historicalVar(returns, confidence)` | `−quantile(Renditen, 1 − confidence)` (lineare Interpolation wie numpy/pandas) |
| CVaR / Expected Shortfall (Tail-Mittel des VaR-Quantils) | `expectedShortfall(returns, confidence)` | `−Mittel aller Renditen ≤ Quantil(1 − confidence)` |
| `gs_quant.timeseries.econometrics.sharpe_ratio` | `sharpeRatio(series, riskFreeAnnual)` | Überschussrendite je Zeitraum mit Act/360: `r_t − rf · ΔTage/360`; Sharpe = `Mittel(Überschuss) / Std(Überschuss) · √Faktor` |
| Beta (Kovarianz/Varianz gegen Benchmark) | `beta(rsA, rsB)` | `cov(r_p, r_b) / var(r_b)` ( Stichprobe, N−1 ) |
| `gs_quant.timeseries.measures_reports.tracking_error` | `trackingError(rsA, rsB, factor)` | `std(r_p − r_b) · √Faktor` |
| — (Aggregation für die App) | `portfolioRisk(snapshots, {confidence, riskFreeAnnual})` | bündelt alles oben auf der Tagesstand-Serie; `varAmount`/`cvarAmount` = VaR/CVaR als Betrag auf den letzten Wert; Benchmark-Vergleich (Beta, Tracking Error, annualisierte Benchmark-Rendite), wenn erster und letzter Tagesstand denselben `benchmarkName` mit Indexständen > 0 haben |

`quantile()` implementiert das „linear"-Verfahren (gleicher Algorithmus wie `numpy.quantile` /
`pandas.Series.quantile` default).

## Wo es in der App sichtbar ist

- `portfolio-ui.js` → `historySection()` ruft `portfolioRisk(p().snapshots)` auf und rendert
  unterhalb des bestehenden Renditevergleichs eine Kachel mit: annualisierte Rendite p.a.,
  Volatilität p.a., maximaler Drawdown, VaR 95 % und CVaR 95 % (in € auf den letzten Stand),
  Sharpe Ratio sowie — falls Vergleichsindex-Stände erfasst sind — Beta und Tracking Error.
- `quant.js` wird vom Service Worker (`sw.js`, ASSETS-Liste) mitgecacht und in `index.html`
  per `modulepreload` vorgeladen.

## Tests

`tests/quant.test.mjs` (ausgeführt mit `npm test`, also `node --test tests/`) prüft jede Funktion
an handgerechneten Beispielen (z. B. `std([2,4,4,4,5,5,7,9], 1) = √(32/7)`, VaR/ES an fünf
Renditen, Drawdown an [100, 120, 90, 130] = −25 %).

## Lizenz-Hinweis

gs-quant steht unter der Apache-2.0-Lizenz. Dieser Port übernahm die Formeln; die JavaScript-Umsetzung
in `quant.js` ist neu geschrieben und unterliegt der Lizenz dieses Repos.
