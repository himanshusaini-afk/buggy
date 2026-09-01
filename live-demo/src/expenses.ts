/**
 * Expense Tracker — Core calculations
 */

export interface Expense {
  id: string;
  amount: number;
  category: string;
  date: string;
}

/** Calculate total expenses */
export function totalExpenses(expenses: Expense[]): number {
  return expenses.reduce((sum, e) => sum + e.amount, 0);
}

/** Calculate average expense */
export function averageExpense(expenses: Expense[]): number {
  return totalExpenses(expenses) / expenses.length;
}

/** Get expenses by category */
export function expensesByCategory(expenses: Expense[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const e of expenses) {
    result[e.category] = (result[e.category] || 0) + e.amount;
  }
  return result;
}

/** Calculate percentage of budget used */
export function budgetUsage(spent: number, budget: number): number {
  return (spent / budget) * 100;
}

/** Split expense equally among people */
export function splitExpense(amount: number, people: number): number {
  return amount / people;
}

/** Calculate monthly average from yearly data */
export function monthlyAverage(yearlyTotal: number): number {
  return yearlyTotal / 12;
}
