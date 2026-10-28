# Project Team

A user assembles an AI team around a project and steers its work through usable deliverables and milestone reviews.

## Language

**Task fit**: The alignment between a task's needs and a member's responsibility, model capability and reasoning effort.
_Avoid_: Always choosing the largest model, guaranteed cheapest model

**Team member**: An agent selected by the user for a responsibility within the team.

**Manager**: The member who helps shape plans and proposes delegation within the user's approved workflow.

**Builder**: A member responsible for producing the declared deliverables of an approved task.

**Reviewer**: A member responsible for independently evaluating captured deliverable versions.

**Capability profile**: The model and supported reasoning effort chosen for a member's work.
_Avoid_: Fixed price tier, guaranteed token cost

**Deliverable**: A usable result that the user or another member can work with.
_Avoid_: A chat reply as the only completed output

**Captured version**: The immutable form of a deliverable used for review or handoff.

**Milestone acceptance**: The user's acceptance of an exact set of output versions, allowing dependent work to continue.

**Project credit**: A unit of attributable usage measured as 1,000 reported tokens.
_Avoid_: Money, account quota percentage

**Provider quota**: The account-wide allowance reported by the model provider, separate from the project's credit budget.
