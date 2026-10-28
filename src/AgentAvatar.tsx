export const agentPortrait = (role = "manager") =>
  "/avatars/" +
  (role === "builder" || role === "reviewer" ? role : "manager") +
  ".png";

export function AgentAvatar({
  role = "manager",
  className = "",
}: {
  role?: string;
  className?: string;
}) {
  return (
    <img
      className={"agent-avatar " + className}
      src={agentPortrait(role)}
      alt=""
      decoding="async"
    />
  );
}
