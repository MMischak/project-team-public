export const agentPortrait = (role = "manager", avatarId?: string) => {
  if (role === "manager") return "/avatars/manager.png";
  const character =
    avatarId && /^(0[1-8])$/.test(avatarId)
      ? avatarId
      : role === "reviewer"
        ? "02"
        : "01";
  return `/avatars/character-${character}.png`;
};

export function AgentAvatar({
  role = "manager",
  avatarId,
  className = "",
}: {
  role?: string;
  avatarId?: string;
  className?: string;
}) {
  return (
    <img
      className={"agent-avatar " + className}
      src={agentPortrait(role, avatarId)}
      alt=""
      decoding="async"
    />
  );
}
