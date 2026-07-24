function excludeOwned(games, ownedItadIds) {
  if (!ownedItadIds || !ownedItadIds.length) return games;
  const ownedSet = new Set(ownedItadIds);
  return games.filter(g => !ownedSet.has(g.appId));
}

function excludeHidden(games, hiddenItadIds) {
  if (!hiddenItadIds || !hiddenItadIds.length) return games;
  const hiddenSet = new Set(hiddenItadIds);
  return games.filter(g => !hiddenSet.has(g.appId));
}

module.exports = { excludeOwned, excludeHidden };
