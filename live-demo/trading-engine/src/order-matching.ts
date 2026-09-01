/**
 * Trading Engine — Order Matching
 */

export interface Order {
  id: string;
  side: 'buy' | 'sell';
  price: number;
  quantity: number;
  timestamp: number;
}

export interface Trade {
  buyOrderId: string;
  sellOrderId: string;
  price: number;
  quantity: number;
  timestamp: number;
}

/** Match a new order against the order book (price-time priority) */
export function matchOrder(
  incoming: Order,
  book: Order[]
): { trades: Trade[]; remainingQuantity: number } {
  const trades: Trade[] = [];
  let remaining = incoming.quantity;

  // Filter opposite-side orders
  const candidates = book
    .filter(o => o.side !== incoming.side)
    .sort((a, b) => {
      // BUG: Sort logic is inverted for sell orders
      if (incoming.side === 'buy') return a.price - b.price; // Buy wants lowest price
      return a.price - b.price; // BUG: Should be b.price - a.price for sells (want highest bid)
    });

  for (const candidate of candidates) {
    if (remaining <= 0) break;

    // Check if prices cross
    const pricesCross = incoming.side === 'buy'
      ? incoming.price >= candidate.price
      : incoming.price <= candidate.price;

    if (!pricesCross) break;

    const fillQty = Math.min(remaining, candidate.quantity);
    trades.push({
      buyOrderId: incoming.side === 'buy' ? incoming.id : candidate.id,
      sellOrderId: incoming.side === 'sell' ? incoming.id : candidate.id,
      price: candidate.price,
      quantity: fillQty,
      timestamp: Date.now(),
    });

    remaining -= fillQty;
    candidate.quantity -= fillQty; // BUG: Mutates the book directly
  }

  return { trades, remainingQuantity: remaining };
}

/** Calculate VWAP (Volume-Weighted Average Price) */
export function vwap(trades: Trade[]): number {
  let totalVolume = 0;
  let totalValue = 0;

  for (const trade of trades) {
    totalVolume += trade.quantity;
    totalValue += trade.price * trade.quantity;
  }

  return totalValue / totalVolume; // BUG: NaN for empty trades array
}

/** Calculate spread between best bid and ask */
export function spread(bids: number[], asks: number[]): number {
  const bestBid = Math.max(...bids);   // BUG: -Infinity for empty array
  const bestAsk = Math.min(...asks);   // BUG: Infinity for empty array
  return bestAsk - bestBid;
}

/** Calculate mid-price */
export function midPrice(bestBid: number, bestAsk: number): number {
  return (bestBid + bestAsk) / 2; // BUG: No validation bid < ask, could return nonsense
}

/** Calculate order book imbalance (0 to 1) */
export function bookImbalance(bidVolume: number, askVolume: number): number {
  return bidVolume / (bidVolume + askVolume); // BUG: NaN when both are 0
}
