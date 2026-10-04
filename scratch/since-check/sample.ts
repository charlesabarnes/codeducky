// Throwaway file for the since-last-look check on PR review. Deleted with the branch.
export interface Order {
  id: string
  totalCents: number
  discountCents: number
}

export function payable(order: Order): number {
  return Math.max(0, order.totalCents - order.discountCents)
}

export function describe(order: Order): string {
  return `Order ${order.id}: ${payable(order)} cents`
}

export function isFree(order: Order): boolean {
  return payable(order) === 0
}
