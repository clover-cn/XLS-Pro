const fs = require('fs');
const { RULES_FILE } = require('./config');

function loadRules() {
  if (!fs.existsSync(RULES_FILE)) return [];
  return JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
}

function saveRules(rules) {
  fs.writeFileSync(RULES_FILE, `${JSON.stringify(rules, null, 2)}\n`, 'utf8');
}

function scoreRule(rule, text) {
  const haystack = text.toLowerCase();
  const tokens = [
    rule.condition,
    rule.action,
    ...(Array.isArray(rule.tags) ? rule.tags : []),
  ].join(' ').toLowerCase().split(/[\s,，、=：:->]+/).filter(Boolean);
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function retrieveRules(metadata, requirement, temporaryRules) {
  const text = [
    requirement,
    temporaryRules,
    ...(metadata.columns || []).map((column) => `${column.name} ${column.type}`),
    ...(metadata.rawRows || []).flatMap((row) => row.values || []),
  ].join(' ');
  return loadRules()
    .map((rule) => ({ ...rule, score: scoreRule(rule, text) }))
    .filter((rule) => rule.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

module.exports = { loadRules, saveRules, retrieveRules };
