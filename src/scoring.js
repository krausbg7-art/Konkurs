// Points: valid votes × VOTE_POINTS + VIDEO_BONUS if the video is approved (once).
// Tie-break: whoever reached their final total earlier wins. A company reaches its
// final total at the later of: its last valid vote, or the approval of its video.
// No lottery: if two companies match even on that moment, the page flags it for
// the organiser instead of picking one.

export async function ranking(db, contest) {
  const { rows } = await db.query(
    `select c.id, c.slug, c.name, c.city,
            coalesce(v.cnt, 0)::int as votes,
            (vid.approved_at is not null) as has_video_bonus,
            coalesce(v.cnt, 0) * $1::int + case when vid.approved_at is not null then $2::int else 0 end as score,
            r.reached_at,
            (extract(epoch from r.reached_at) * 1000000)::bigint as reached_us
       from companies c
       left join (select company_id, count(*) as cnt, max(created_at) as last_at
                    from votes where status = 'valid' group by company_id) v on v.company_id = c.id
       left join (select company_id, moderated_at as approved_at
                    from videos where status = 'approved') vid on vid.company_id = c.id
       cross join lateral (select nullif(greatest(coalesce(v.last_at, '-infinity'), coalesce(vid.approved_at, '-infinity')),
                                         '-infinity'::timestamptz) as reached_at) r
      where c.status = 'approved' and c.disqualified_at is null
      order by score desc, r.reached_at asc nulls last, c.id asc`,
    [contest.votePoints, contest.videoBonus],
  );

  // reached_us keeps microseconds (JS Date only has milliseconds).
  // Positions, with exact ties (same score and same moment) sharing a place.
  let place = 0;
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    const tiedWithPrev = prev && prev.score === r.score && prev.reached_us === r.reached_us;
    if (!tiedWithPrev) place = i + 1;
    r.place = place;
    r.unresolvedTie = false;
  });
  rows.forEach((r, i) => {
    const next = rows[i + 1];
    if (next && next.place === r.place && r.score > 0) { r.unresolvedTie = true; next.unresolvedTie = true; }
  });
  return rows;
}

export function winners(rows, count) {
  return rows.filter((r) => r.place <= count && r.score > 0);
}
