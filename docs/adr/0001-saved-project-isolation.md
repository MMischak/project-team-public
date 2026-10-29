# Separate project histories behind one shared team

Saved projects use separate databases and native history homes behind a small catalog, rather than introducing project scoping into every existing history/recovery table. The legacy database and native paths remain in place, even after the Tinkrew rename, because moving them would put existing interrupted-work identities at risk. Only member identity/configuration is shared; one hub drains and closes the current coordinator before opening another, and one aggregate app storage budget covers every saved project.
