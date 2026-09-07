// GENERADO POR scripts/generar-contrato-csharp.mjs — NO SE EDITA A MANO.
//
// Fuente: apps/server/src/domain.ts. Si esto y la fuente no coinciden, el
// build falla (ADR-0005): el vocabulario del Núcleo tiene UNA sola fuente.
//
// Cada enum lleva Unknown = 0 a propósito (artículo 13): un valor nuevo del
// servidor no puede romper una APK que ya está instalada en un teléfono.

using System.Runtime.Serialization;

namespace Torreon.Contrato
{
    public enum ActStatus
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "locked")]
        Locked = 1,
        [EnumMember(Value = "available")]
        Available = 2,
        [EnumMember(Value = "active")]
        Active = 3,
        [EnumMember(Value = "completed")]
        Completed = 4,
        [EnumMember(Value = "abandoned")]
        Abandoned = 5,
    }

    public enum AdPlacementId
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "battle_passive")]
        BattlePassive = 1,
        [EnumMember(Value = "battle_result")]
        BattleResult = 2,
        [EnumMember(Value = "extra_battle_reward")]
        ExtraBattleReward = 3,
    }

    public enum ArtifactKind
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "file")]
        File = 1,
        [EnumMember(Value = "link")]
        Link = 2,
        [EnumMember(Value = "text")]
        Text = 3,
    }

    public enum AttemptEndReason
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "won")]
        Won = 1,
        [EnumMember(Value = "timeout")]
        Timeout = 2,
        [EnumMember(Value = "recontracted")]
        Recontracted = 3,
        [EnumMember(Value = "player_ko")]
        PlayerKo = 4,
        [EnumMember(Value = "abandoned")]
        Abandoned = 5,
    }

    public enum BattleStatus
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "active")]
        Active = 1,
        [EnumMember(Value = "suspended_external")]
        SuspendedExternal = 2,
        [EnumMember(Value = "awaiting_replan")]
        AwaitingReplan = 3,
        [EnumMember(Value = "awaiting_recovery")]
        AwaitingRecovery = 4,
        [EnumMember(Value = "won")]
        Won = 5,
    }

    public enum CampaignStatus
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "draft")]
        Draft = 1,
        [EnumMember(Value = "active")]
        Active = 2,
        [EnumMember(Value = "completed")]
        Completed = 3,
        [EnumMember(Value = "abandoned")]
        Abandoned = 4,
    }

    public enum CompanionId
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "opus")]
        Opus = 1,
        [EnumMember(Value = "codex")]
        Codex = 2,
        [EnumMember(Value = "claude")]
        Claude = 3,
        [EnumMember(Value = "gemini")]
        Gemini = 4,
    }

    public enum EnemyPosition
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "front")]
        Front = 1,
        [EnumMember(Value = "back")]
        Back = 2,
    }

    public enum EnemyRole
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "tank")]
        Tank = 1,
        [EnumMember(Value = "ranged")]
        Ranged = 2,
        [EnumMember(Value = "assassin")]
        Assassin = 3,
        [EnumMember(Value = "breaker")]
        Breaker = 4,
        [EnumMember(Value = "support")]
        Support = 5,
        [EnumMember(Value = "drain")]
        Drain = 6,
        [EnumMember(Value = "mage")]
        Mage = 7,
        [EnumMember(Value = "disruptor")]
        Disruptor = 8,
        [EnumMember(Value = "berserker")]
        Berserker = 9,
        [EnumMember(Value = "captain")]
        Captain = 10,
    }

    public enum EvidenceKind
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "file")]
        File = 1,
        [EnumMember(Value = "link")]
        Link = 2,
        [EnumMember(Value = "screenshot")]
        Screenshot = 3,
        [EnumMember(Value = "photo")]
        Photo = 4,
        [EnumMember(Value = "number")]
        Number = 5,
        [EnumMember(Value = "text")]
        Text = 6,
        [EnumMember(Value = "declaration")]
        Declaration = 7,
    }

    public enum EvidenceSource
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "user_declaration")]
        UserDeclaration = 1,
        [EnumMember(Value = "file")]
        File = 2,
        [EnumMember(Value = "mcp")]
        Mcp = 3,
        [EnumMember(Value = "integration")]
        Integration = 4,
        [EnumMember(Value = "api")]
        Api = 5,
    }

    public enum EvidenceVerdict
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "rejected")]
        Rejected = 1,
        [EnumMember(Value = "partial")]
        Partial = 2,
        [EnumMember(Value = "accepted")]
        Accepted = 3,
    }

    public enum HeroAvailability
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "connected")]
        Connected = 1,
        [EnumMember(Value = "available")]
        Available = 2,
        [EnumMember(Value = "unavailable")]
        Unavailable = 3,
        [EnumMember(Value = "unknown")]
        Unknown = 4,
    }

    public enum HeroKind
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "party")]
        Party = 1,
        [EnumMember(Value = "agent")]
        Agent = 2,
    }

    public enum InventoryItemId
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "revive_tonic")]
        ReviveTonic = 1,
        [EnumMember(Value = "health_potion")]
        HealthPotion = 2,
    }

    public enum NotificationEntityType
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "quest")]
        Quest = 1,
        [EnumMember(Value = "campaign")]
        Campaign = 2,
        [EnumMember(Value = "act")]
        Act = 3,
        [EnumMember(Value = "saga")]
        Saga = 4,
        [EnumMember(Value = "obligation")]
        Obligation = 5,
    }

    public enum NotificationPriority
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "normal")]
        Normal = 1,
        [EnumMember(Value = "high")]
        High = 2,
    }

    public enum NotificationScreen
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "quest")]
        Quest = 1,
        [EnumMember(Value = "campaign")]
        Campaign = 2,
        [EnumMember(Value = "act")]
        Act = 3,
        [EnumMember(Value = "battle")]
        Battle = 4,
        [EnumMember(Value = "treasury")]
        Treasury = 5,
    }

    public enum ObligationDirection
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "expense")]
        Expense = 1,
        [EnumMember(Value = "income")]
        Income = 2,
    }

    public enum PartyMemberId
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "roko")]
        Roko = 1,
        [EnumMember(Value = "marques")]
        Marques = 2,
        [EnumMember(Value = "cordera")]
        Cordera = 3,
    }

    public enum PlanId
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "free")]
        Free = 1,
        [EnumMember(Value = "premium")]
        Premium = 2,
        [EnumMember(Value = "dev")]
        Dev = 3,
    }

    public enum PushStatus
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "sent")]
        Sent = 1,
        [EnumMember(Value = "failed")]
        Failed = 2,
        [EnumMember(Value = "unknown")]
        Unknown = 3,
    }

    public enum QuestStatus
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "draft")]
        Draft = 1,
        [EnumMember(Value = "accepted")]
        Accepted = 2,
        [EnumMember(Value = "active")]
        Active = 3,
        [EnumMember(Value = "waiting_external")]
        WaitingExternal = 4,
        [EnumMember(Value = "completed")]
        Completed = 5,
        [EnumMember(Value = "abandoned")]
        Abandoned = 6,
    }

    public enum StepActor
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "user")]
        User = 1,
        [EnumMember(Value = "codex")]
        Codex = 2,
        [EnumMember(Value = "shared")]
        Shared = 3,
    }

    public enum StepStatus
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "pending")]
        Pending = 1,
        [EnumMember(Value = "in_progress")]
        InProgress = 2,
        [EnumMember(Value = "blocked")]
        Blocked = 3,
        [EnumMember(Value = "superseded")]
        Superseded = 4,
        [EnumMember(Value = "completed")]
        Completed = 5,
    }

    public enum TargetPolicy
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "frontline")]
        Frontline = 1,
        [EnumMember(Value = "backline")]
        Backline = 2,
        [EnumMember(Value = "lowest_health")]
        LowestHealth = 3,
        [EnumMember(Value = "shield_first")]
        ShieldFirst = 4,
        [EnumMember(Value = "weighted")]
        Weighted = 5,
    }

    public enum TransactionStatus
    {
        [EnumMember(Value = "")]
        Unknown = 0,
        [EnumMember(Value = "confirmed")]
        Confirmed = 1,
        [EnumMember(Value = "pending")]
        Pending = 2,
    }

}
