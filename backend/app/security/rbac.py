"""Roles, permissions and approval levels.

Every action type has a fixed level defined here. The AI cannot change it, and the server
checks both the level and the user's role before anything runs.
"""

from dataclasses import dataclass
from enum import IntEnum


class Role:
    OWNER = "owner"
    FINANCE_MANAGER = "finance_manager"
    BOOKKEEPER = "bookkeeper"
    EMPLOYEE = "employee"
    ALL = {OWNER, FINANCE_MANAGER, BOOKKEEPER, EMPLOYEE}


class Perm:
    VIEW_ALL = "view_all"  # every record, original and recommendation
    VIEW_OWN_SUBMISSIONS = "view_own_submissions"
    SUBMIT_RECEIPT = "submit_receipt"
    REVIEW_DOCUMENTS = "review_documents"
    APPROVE_MATCH = "approve_match"
    RECORD_BILL = "record_bill"
    RECONCILE = "reconcile"
    PREPARE_PAYMENT = "prepare_payment"
    SEND_REMINDER = "send_reminder"
    APPROVE_PAYMENT = "approve_payment"
    APPROVE_HIGH_RISK = "approve_high_risk"  # level 4, as one of two people
    CONNECT_TOOLS = "connect_tools"
    USE_FINANCING = "use_financing"
    SHARE_LENDER_PACK = "share_lender_pack"
    EDIT_PROFILE = "edit_profile"
    MANAGE_USERS = "manage_users"
    SET_LIMITS = "set_limits"
    PAUSE_AI = "pause_ai"
    USE_ASSISTANT = "use_assistant"
    VIEW_ACTIVITY = "view_activity"


_BOOKKEEPER = {
    Perm.VIEW_ALL, Perm.VIEW_OWN_SUBMISSIONS, Perm.SUBMIT_RECEIPT, Perm.REVIEW_DOCUMENTS, Perm.APPROVE_MATCH,
    Perm.RECORD_BILL, Perm.RECONCILE, Perm.PREPARE_PAYMENT, Perm.SEND_REMINDER, Perm.USE_ASSISTANT,
    Perm.VIEW_ACTIVITY,
}
_FINANCE_MANAGER = _BOOKKEEPER | {
    Perm.APPROVE_PAYMENT, Perm.APPROVE_HIGH_RISK, Perm.CONNECT_TOOLS, Perm.USE_FINANCING,
}
_OWNER = _FINANCE_MANAGER | {
    Perm.SHARE_LENDER_PACK, Perm.EDIT_PROFILE, Perm.MANAGE_USERS, Perm.SET_LIMITS, Perm.PAUSE_AI,
}
_EMPLOYEE = {Perm.SUBMIT_RECEIPT, Perm.VIEW_OWN_SUBMISSIONS}

ROLE_PERMS: dict[str, set[str]] = {
    Role.OWNER: _OWNER,
    Role.FINANCE_MANAGER: _FINANCE_MANAGER,
    Role.BOOKKEEPER: _BOOKKEEPER,
    Role.EMPLOYEE: _EMPLOYEE,
}

# Roles that can approve payments must use two-step sign-in
TOTP_REQUIRED_ROLES = {Role.OWNER, Role.FINANCE_MANAGER}


def perms_for(roles: list[str], second_approver: bool = False) -> set[str]:
    out: set[str] = set()
    for r in roles:
        out |= ROLE_PERMS.get(r, set())
    if second_approver:
        out.add(Perm.APPROVE_HIGH_RISK)
    return out


class Level(IntEnum):
    READ = 0
    SUGGEST = 1
    SMALL_CHANGE = 2
    OUTSIDE = 3
    HIGH_RISK = 4


LEVEL_LABELS = {0: "Read", 1: "Suggest", 2: "Small change", 3: "Outside action", 4: "Two people"}


@dataclass(frozen=True)
class ActionSpec:
    level: Level
    approve_perm: str
    label: str


# The only actions that exist. Anything else is refused.
ACTIONS: dict[str, ActionSpec] = {
    "accept_match": ActionSpec(Level.SMALL_CHANGE, Perm.APPROVE_MATCH, "Accept a match"),
    "record_bill": ActionSpec(Level.SMALL_CHANGE, Perm.RECORD_BILL, "Record a bill"),
    "approve_document": ActionSpec(Level.SMALL_CHANGE, Perm.REVIEW_DOCUMENTS, "Approve an extracted document"),
    "post_to_accounting": ActionSpec(Level.OUTSIDE, Perm.RECORD_BILL, "Update the accounting software"),
    "send_payment_reminder": ActionSpec(Level.OUTSIDE, Perm.SEND_REMINDER, "Email a customer"),
    "email_supplier": ActionSpec(Level.OUTSIDE, Perm.SEND_REMINDER, "Email a supplier"),
    "schedule_payment": ActionSpec(Level.OUTSIDE, Perm.APPROVE_PAYMENT, "Schedule a payment"),
    "share_lender_pack": ActionSpec(Level.OUTSIDE, Perm.SHARE_LENDER_PACK, "Share a lender pack"),
    "change_supplier_bank": ActionSpec(Level.HIGH_RISK, Perm.APPROVE_HIGH_RISK, "Change supplier bank details"),
    "large_payment": ActionSpec(Level.HIGH_RISK, Perm.APPROVE_HIGH_RISK, "Large or first-time payment"),
    # Getting paid: closes what is left after a payment arrived short (finance managers and owners)
    "record_bank_charge": ActionSpec(Level.SMALL_CHANGE, Perm.APPROVE_PAYMENT, "Record a bank charge"),
}

# Never available to the AI, whatever it asks for
AI_FORBIDDEN = {"manage_users", "set_limits", "reveal_pii", "move_money"}
