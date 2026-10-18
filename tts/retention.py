"""Remove expired future Sky audio via Storage API; never back up recordings."""
import logging
import re

LOG = logging.getLogger('stash.audio')


def cleanup_expired_audio(api):
    """The database supplies only expired, unreferenced, immutable object paths.

    Limit work per cycle so cleanup cannot starve queued synthesis. Failed
    deletes remain in the outbox for the next cycle. Regeneration uses a new
    job/object UUID, so replaying a delete cannot remove the new recording.
    """
    pending = api.rpc('collect_stash_audio_expirations', p_user_id=api.user)
    if not pending:
        return 0
    expected = re.compile(re.escape(api.user) + r'/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp3')
    if any(not expected.fullmatch(row['object_name']) for row in pending):
        raise RuntimeError('Retention received an unexpected object path; nothing was deleted')
    api.heartbeat()
    # Fixed bucket, exact names, no prefix wildcard or local backup.
    api.call('/storage/v1/object/stash-audio',
             {'prefixes': [row['object_name'] for row in pending]}, method='DELETE', timeout=120)
    removed = api.rpc('ack_stash_audio_deletions', p_user_id=api.user, p_ids=[row['id'] for row in pending])
    LOG.info('Audio retention removed %s expired recordings', removed)
    return removed
