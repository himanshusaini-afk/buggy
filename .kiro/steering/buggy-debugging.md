# Buggy — Proof-Carrying Debugging Workflow

## When to Use

Use Buggy whenever:
- A user asks to "check for bugs", "find issues", or "debug" a function
- You're about to modify existing code (check it first)
- A test is failing and you need to understand why
- Code review reveals risky patterns (division, array access, unbounded math)

## How to Use (via MCP tools)

### Step 1: List functions in the target file
```
buggy_list_functions({ file_path: "src/target.ts", project_path: "/path/to/project" })
```

### Step 2: Analyze the file for syntax issues
```
buggy_analyze({ file_path: "src/target.ts", project_path: "/path/to/project" })
```

### Step 3: Investigate a specific function
```
buggy_investigate({
  function_id: "processPayment",
  file_path: "src/target.ts",
  project_path: "/path/to/project",
  preconditions: ["amount > 0"],
  postconditions: ["result >= 0", "result.status !== undefined"]
})
```

### Step 4: Interpret and act on results

When `status` is `confirmed_and_repaired`:
- Explain the proof certificate to the user in plain English
- Show what input triggers the bug
- Present the approved patch and ask if they want to apply it
- Apply using str_replace if they confirm

When `status` is `unconfirmed`:
- Tell the user no bug was found with the given specifications
- Suggest stronger postconditions if the specs seem weak

## Writing Good Specifications

When inferring specs from code context:
- Look for function return types → postconditions about the result type
- Look for parameter constraints (> 0, non-null, length checks) → preconditions
- Look for documented invariants (JSDoc @throws, @returns) → postconditions
- Common patterns:
  - Division → add "denominator !== 0" and "!isNaN(result)"
  - Array access → add "index >= 0 && index < array.length"
  - Money/prices → add "result >= 0"
  - String operations → add "result !== undefined && result !== null"

## Explaining Results to Users

When presenting a proof certificate:
- Lead with the IMPACT: "This function can return a negative price when..."
- Show the TRIGGER: "Specifically, when discount is 150%, the result is -50"
- Explain the FIX: "The approved patch clamps the discount to [0, 100]"
- Note the CONFIDENCE: "Overfitting score: 8% (very likely a genuine fix)"
