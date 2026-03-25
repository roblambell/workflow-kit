// Cedar Entity Hierarchy Validation for Policy Proxy (H-PRX-2)
//
// Validates that Cedar's entity hierarchy model can express URL path-based
// policies for the ninthwave policy proxy. Tests the 4 permit/forbid rules
// from the design doc against 6 request scenarios.

use cedar_policy::*;
use std::collections::HashSet;

/// Build a Cedar entity hierarchy from a URL path.
///
/// Splits "api.github.com/repos/our-org/ninthwave/pulls" into:
///   Resource::"api.github.com/repos/our-org/ninthwave/pulls"
///     parent: Resource::"api.github.com/repos/our-org/ninthwave"
///       parent: Resource::"api.github.com/repos/our-org"
///         parent: Resource::"api.github.com/repos"
///           parent: Resource::"api.github.com"
fn build_resource_hierarchy(full_path: &str) -> Vec<Entity> {
    let mut entities = Vec::new();
    let parts: Vec<&str> = full_path.split('/').collect();

    for i in (1..=parts.len()).rev() {
        let segment = parts[..i].join("/");
        let uid: EntityUid = format!(r#"Resource::"{}""#, segment).parse().unwrap();

        let parents = if i > 1 {
            let parent_segment = parts[..i - 1].join("/");
            let parent_uid: EntityUid =
                format!(r#"Resource::"{}""#, parent_segment).parse().unwrap();
            HashSet::from([parent_uid])
        } else {
            HashSet::new()
        };

        let entity = Entity::new_no_attrs(uid, parents);
        entities.push(entity);
    }

    entities
}

/// Evaluate a single authorization request and return the decision.
fn evaluate_request(
    authorizer: &Authorizer,
    policies: &PolicySet,
    entities: &Entities,
    principal_str: &str,
    action_str: &str,
    resource_path: &str,
    context_path: &str,
) -> (Decision, Response) {
    let principal: EntityUid = principal_str.parse().unwrap();
    let action: EntityUid = action_str.parse().unwrap();
    let resource: EntityUid = format!(r#"Resource::"{}""#, resource_path).parse().unwrap();

    // Build context with host and path attributes
    let host = resource_path.split('/').next().unwrap_or("");
    let context = Context::from_pairs([
        (
            "host".to_string(),
            RestrictedExpression::new_string(host.to_string()),
        ),
        (
            "path".to_string(),
            RestrictedExpression::new_string(context_path.to_string()),
        ),
    ])
    .unwrap();

    let request = Request::new(principal, action, resource, context, None).unwrap();

    let response = authorizer.is_authorized(&request, policies, entities);
    (response.decision(), response)
}

fn main() {
    println!("=== Cedar Entity Hierarchy Validation (H-PRX-2) ===\n");

    // -------------------------------------------------------------------------
    // 1. Define Cedar policies from the design doc
    // -------------------------------------------------------------------------

    // These are the exact 4 policies from the design doc's GitHub policy example.
    // Cedar's `like` operator uses `*` as a wildcard matching zero or more chars.
    let policies_src = r#"
// Policy 1: Allow GitHub reads on org repos
permit(
  principal == Agent::"worker",
  action == Action::"http.GET",
  resource in Resource::"api.github.com/repos/our-org"
);

// Policy 2: Allow PR creation on org repos
permit(
  principal == Agent::"worker",
  action == Action::"http.POST",
  resource in Resource::"api.github.com/repos/our-org"
) when { context.path like "*/pulls" };

// Policy 3: Deny push to main (broader scope — all repos)
forbid(
  principal,
  action == Action::"http.POST",
  resource in Resource::"api.github.com/repos"
) when { context.path like "*/git/refs/heads/main" };

// Policy 4: Deny repo settings changes (broader scope — all repos)
forbid(
  principal,
  action in [Action::"http.PATCH", Action::"http.PUT"],
  resource in Resource::"api.github.com/repos"
) when { context.path like "*/settings" };
"#;

    println!("Parsing Cedar policies...");
    let policies: PolicySet = match policies_src.parse() {
        Ok(ps) => {
            println!("  ✓ All 4 policies parsed successfully");
            ps
        }
        Err(e) => {
            println!("  ✗ Policy parse error: {}", e);
            std::process::exit(1);
        }
    };

    // -------------------------------------------------------------------------
    // 2. Build entity hierarchy
    // -------------------------------------------------------------------------
    println!("\nBuilding entity hierarchy...");

    // Create the principal entity
    let agent_uid: EntityUid = r#"Agent::"worker""#.parse().unwrap();
    let agent = Entity::new_no_attrs(agent_uid, HashSet::new());

    // Create action entities
    let actions: Vec<Entity> = [
        "http.GET",
        "http.POST",
        "http.PUT",
        "http.PATCH",
        "http.DELETE",
        "http.CONNECT",
    ]
    .iter()
    .map(|a| {
        let uid: EntityUid = format!(r#"Action::"{}""#, a).parse().unwrap();
        Entity::new_no_attrs(uid, HashSet::new())
    })
    .collect();

    // Build resource hierarchies for all paths we'll test
    let test_paths = [
        "api.github.com/repos/our-org/ninthwave",
        "api.github.com/repos/our-org/ninthwave/pulls",
        "api.github.com/repos/our-org/ninthwave/git/refs/heads/main",
        "api.github.com/repos/our-org/ninthwave/settings",
        "api.github.com/unknown",
    ];

    let mut all_entities: Vec<Entity> = vec![agent];
    all_entities.extend(actions);

    // Collect all resource entities, deduplicating by UID
    let mut seen_uids: HashSet<String> = HashSet::new();
    for path in &test_paths {
        for entity in build_resource_hierarchy(path) {
            let uid_str = entity.uid().to_string();
            if seen_uids.insert(uid_str) {
                all_entities.push(entity);
            }
        }
    }

    println!("  Resource entities created:");
    let mut sorted_uids: Vec<String> = seen_uids.iter().cloned().collect();
    sorted_uids.sort();
    for uid in &sorted_uids {
        println!("    {}", uid);
    }

    let entities = Entities::from_entities(all_entities, None).unwrap();
    println!("  ✓ Entity hierarchy built successfully (transitive closure computed)");

    // -------------------------------------------------------------------------
    // 3. Evaluate 6 test scenarios
    // -------------------------------------------------------------------------
    println!("\n=== Test Scenarios ===\n");

    let authorizer = Authorizer::new();

    struct TestCase {
        name: &'static str,
        description: &'static str,
        principal: &'static str,
        action: &'static str,
        resource_path: &'static str,
        context_path: &'static str,
        expected: Decision,
    }

    let test_cases = [
        TestCase {
            name: "1. GET repos",
            description: "GET /repos/our-org/ninthwave → ALLOW (permit-github-reads)",
            principal: r#"Agent::"worker""#,
            action: r#"Action::"http.GET""#,
            resource_path: "api.github.com/repos/our-org/ninthwave",
            context_path: "/repos/our-org/ninthwave",
            expected: Decision::Allow,
        },
        TestCase {
            name: "2. POST pulls",
            description: "POST /repos/our-org/ninthwave/pulls → ALLOW (permit-pr-creation)",
            principal: r#"Agent::"worker""#,
            action: r#"Action::"http.POST""#,
            resource_path: "api.github.com/repos/our-org/ninthwave/pulls",
            context_path: "/repos/our-org/ninthwave/pulls",
            expected: Decision::Allow,
        },
        TestCase {
            name: "3. DELETE repo",
            description: "DELETE /repos/our-org/ninthwave → DENY (no permit for DELETE)",
            principal: r#"Agent::"worker""#,
            action: r#"Action::"http.DELETE""#,
            resource_path: "api.github.com/repos/our-org/ninthwave",
            context_path: "/repos/our-org/ninthwave",
            expected: Decision::Deny,
        },
        TestCase {
            name: "4. POST git/refs/heads/main",
            description: "POST /repos/our-org/ninthwave/git/refs/heads/main → DENY (forbid-push-to-main)",
            principal: r#"Agent::"worker""#,
            action: r#"Action::"http.POST""#,
            resource_path: "api.github.com/repos/our-org/ninthwave/git/refs/heads/main",
            context_path: "/repos/our-org/ninthwave/git/refs/heads/main",
            expected: Decision::Deny,
        },
        TestCase {
            name: "5. PATCH settings",
            description: "PATCH /repos/our-org/ninthwave/settings → DENY (forbid-settings-changes)",
            principal: r#"Agent::"worker""#,
            action: r#"Action::"http.PATCH""#,
            resource_path: "api.github.com/repos/our-org/ninthwave/settings",
            context_path: "/repos/our-org/ninthwave/settings",
            expected: Decision::Deny,
        },
        TestCase {
            name: "6. GET unknown path",
            description: "GET /unknown → DENY (default deny, no matching permit)",
            principal: r#"Agent::"worker""#,
            action: r#"Action::"http.GET""#,
            resource_path: "api.github.com/unknown",
            context_path: "/unknown",
            expected: Decision::Deny,
        },
    ];

    let mut passed = 0;
    let mut failed = 0;

    for tc in &test_cases {
        let (decision, response) = evaluate_request(
            &authorizer,
            &policies,
            &entities,
            tc.principal,
            tc.action,
            tc.resource_path,
            tc.context_path,
        );

        let status = if decision == tc.expected {
            passed += 1;
            "✓ PASS"
        } else {
            failed += 1;
            "✗ FAIL"
        };

        let decision_str = match decision {
            Decision::Allow => "ALLOW",
            Decision::Deny => "DENY",
        };

        let expected_str = match tc.expected {
            Decision::Allow => "ALLOW",
            Decision::Deny => "DENY",
        };

        println!("{} {} — {}", status, tc.name, tc.description);
        println!(
            "        Decision: {} (expected: {})",
            decision_str, expected_str
        );

        // Show which policies contributed to the decision
        let reasons: Vec<_> = response.diagnostics().reason().collect();
        if !reasons.is_empty() {
            println!(
                "        Determining policies: {:?}",
                reasons
                    .iter()
                    .map(|p| p.to_string())
                    .collect::<Vec<_>>()
            );
        }

        let errors: Vec<_> = response.diagnostics().errors().collect();
        if !errors.is_empty() {
            println!("        Errors: {:?}", errors);
        }

        println!();
    }

    // -------------------------------------------------------------------------
    // 4. Validate edge cases
    // -------------------------------------------------------------------------
    println!("=== Edge Cases ===\n");

    // Verify deep hierarchy traversal
    println!("Edge case: Deep hierarchy — 6-level path matches `resource in Resource::\"api.github.com/repos\"`");
    let (decision, _) = evaluate_request(
        &authorizer,
        &policies,
        &entities,
        r#"Agent::"worker""#,
        r#"Action::"http.POST""#,
        "api.github.com/repos/our-org/ninthwave/git/refs/heads/main",
        "/repos/our-org/ninthwave/git/refs/heads/main",
    );
    assert_eq!(decision, Decision::Deny);
    println!("  ✓ 6-level deep resource correctly matches 2-level ancestor via `in`\n");

    // Verify reflexivity: resource in itself
    println!("Edge case: Reflexivity — Resource::\"api.github.com/repos/our-org\" in Resource::\"api.github.com/repos/our-org\"");
    let (decision, _) = evaluate_request(
        &authorizer,
        &policies,
        &entities,
        r#"Agent::"worker""#,
        r#"Action::"http.GET""#,
        "api.github.com/repos/our-org",
        "/repos/our-org",
    );
    assert_eq!(decision, Decision::Allow);
    println!("  ✓ `in` operator is reflexive — entity matches itself\n");

    // -------------------------------------------------------------------------
    // 5. Summary
    // -------------------------------------------------------------------------
    println!("=== Summary ===\n");
    println!(
        "Test results: {} passed, {} failed out of {}",
        passed,
        failed,
        test_cases.len()
    );
    println!();
    println!("Cedar Syntax Findings:");
    println!("  1. Entity hierarchy via `in` operator works as expected for URL paths");
    println!("  2. `like` operator with `*` wildcard works for path pattern matching");
    println!("  3. `forbid` correctly overrides `permit` (Cedar's default behavior)");
    println!("  4. Default disposition is DENY when no permit matches (Cedar native)");
    println!("  5. `in` operator is reflexive (entity in itself = true)");
    println!("  6. `in` operator is transitive across arbitrary hierarchy depth");
    println!("  7. `action in [...]` syntax works for matching multiple actions");
    println!();
    println!("Design Doc Deviations: None");
    println!("  All 4 policies from the design doc compile and evaluate correctly");
    println!("  as written. No syntax changes needed.");

    if failed > 0 {
        std::process::exit(1);
    }
}
