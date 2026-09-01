/**
 * Expense Tracker — Report generation
 */

import type { Expense } from './expenses.js';

export interface Report {
  totalSpent: number;
  averagePerDay: number;
  topCategory: string;
  topCategoryAmount: number;
  savingsRate: number;
}

/** Generate a spending report */
export function generateReport(
  expenses: Expense[],
  income: number,
  periodDays: number
): Report {
  const totalSpent = expenses.reduce((sum, e) => sum + e.amount, 0);
  const averagePerDay = totalSpent / periodDays;

  // Find top category
  const categories: Record<string, number> = {};
  for (const e of expenses) {
    categories[e.category] = (categories[e.category] || 0) + e.amount;
  }

  const entries = Object.entries(categories);
  entries.sort((a, b) => b[1] - a[1]);

  const topCategory = entries[0][0]; // Could crash if no expenses
  const topCategoryAmount = entries[0][1];

  // Savings rate
  const savingsRate = ((income - totalSpent) / income) * 100;

  return {
    totalSpent,
    averagePerDay,
    topCategory,
    topCategoryAmount,
    savingsRate,
  };
}

/** Calculate month-over-month growth rate */
export function growthRate(currentMonth: number, previousMonth: number): number {
  return ((currentMonth - previousMonth) / previousMonth) * 100;
}

/** Calculate compound savings projection */
export function compoundProjection(
  monthlySavings: number,
  annualRate: number,
  months: number
): number {
  const monthlyRate = annualRate / 12 / 100;
  let total = 0;
  for (let i = 0; i < months; i++) {
    total = (total + monthlySavings) * (1 + monthlyRate);
  }
  return total;
}
