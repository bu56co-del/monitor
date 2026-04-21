// Targets to track. Each entry has:
//   id:   numeric `view_all_page_id` from the FB Ad Library URL
//   name: human-friendly label shown on the dashboard
//
// To add a target, paste the Ad Library link, copy the digits after
// `view_all_page_id=`, and add a new entry. Order does not matter for
// scheduling (targets are picked round-robin by hour-of-day).

module.exports = [
  { id: '110379081699089', name: 'HKMPM (original)' },
  { id: '89863844963',     name: 'Demo target' },
  // user will fill in the remaining ~14 targets here
];
