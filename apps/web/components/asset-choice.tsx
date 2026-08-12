import type { AssetSymbol, PublicCheckout } from "../lib/api";

export function AssetChoice({
  assets,
  selected,
  disabled,
  onSelect,
}: {
  readonly assets: PublicCheckout["acceptedAssets"];
  readonly selected: AssetSymbol | null;
  readonly disabled: boolean;
  readonly onSelect: (symbol: AssetSymbol) => void;
}) {
  return (
    <fieldset className="asset-choice" disabled={disabled}>
      <legend>Choose the asset you will send</legend>
      <div className="asset-grid">
        {assets.map((asset) => (
          <button
            key={asset.symbol}
            type="button"
            className="asset-option"
            aria-pressed={selected === asset.symbol}
            onClick={() => onSelect(asset.symbol)}
          >
            <span className="asset-mark" aria-hidden="true">
              {asset.symbol.slice(0, 1)}
            </span>
            <span>
              <strong>{asset.symbol}</strong>
              <small>Solana · 6 decimals</small>
            </span>
            <span className="radio-mark" aria-hidden="true" />
          </button>
        ))}
      </div>
    </fieldset>
  );
}
