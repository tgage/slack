const {
  Subscribed, NotFound, AlreadySubscribed, NotSubscribed,
} = require('../renderer/flow');

/**
 * Subscribes a slack channel to activity from an Organization or Repository
 *
 * Usage:
 *   /github subscribe https://github.com/org/repo
 */
module.exports = async (req, res) => {
  const {
    robot, resource, installation, gitHubUser, slackWorkspace, slackUser,
  } = res.locals;
  const { Subscription, LegacySubscription } = robot.models;
  const { command } = res.locals;

  req.log.debug({ installation, resource }, 'Lookup respository to subscribe');

  async function respondWith(message) {
    if (/api\.slack\.com/.test(req.headers['user-agent'])) {
      res.json(message);
    } else {
      await command.respond(message.toJSON());
      res.redirect(`https://slack.com/app_redirect?channel=${command.channel_id}&team=${command.team_id}`);
    }
  }


  // look up the resource
  let from;
  try {
    from = (await gitHubUser.client.repos.get({ owner: resource.owner, repo: resource.repo })
    ).data;
  } catch (e) {
    req.log.trace(e, "couldn't find repo");
    return respondWith(new NotFound(command.args[0]));
  }
  const to = command.channel_id;

  let subscription = await Subscription.lookupOne(from.id, to, slackWorkspace.id, installation.id);
  const settings = command.args[1];

  if (command.subcommand === 'subscribe') {
    if (subscription) {
      if (settings) {
        req.log.debug({ settings }, 'Subscription already exists, updating settings');
        subscription.enable(settings);
        await subscription.save();
        respondWith(new Subscribed({ channelId: to, fromRepository: from }));
      }
      req.log.debug('Subscription already exists');
      return respondWith(new AlreadySubscribed(command.args[0]));
    }
    req.log.debug('Subscription does not exist, creating.');
    subscription = await Subscription.subscribe({
      channelId: to,
      creatorId: slackUser.id,
      githubId: from.id,
      installationId: installation.id,
      settings,
      slackWorkspaceId: slackWorkspace.id,
    });

    // check if there are any legacy configurations that we can disable
    const legacySubscriptions = await LegacySubscription.findAll({
      where: {
        activatedAt: null,
        channelSlackId: to,
        repoGitHubId: from.id,
        workspaceSlackId: slackWorkspace.slackId,
      },
    });
    await Promise.all(legacySubscriptions.map(async (legacySubscription) => {
      // call Slack API to disable subscription
      // eslint-disable-next-line no-underscore-dangle
      const payload = {
        payload: JSON.stringify({
          action: 'mark_subscribed',
          repo: {
            full_name: legacySubscription.repoFullName,
            id: legacySubscription.repoGitHubId,
          },
          service_type: 'github',
        }),
        service: legacySubscription.serviceSlackId,
      };
      req.log.debug('Removing legacy configuration', payload);

      const { client } = slackWorkspace;
      // eslint-disable-next-line no-underscore-dangle
      const configurationRemovalRes = await client._makeAPICall('services.update', payload);
      req.log.debug('Removed legacy configuration', configurationRemovalRes);

      const config = legacySubscription.originalSlackConfiguration;

      await subscription.update({
        settings: {
          branches: subscription.settings.branches || config.do_branches,
          comments: subscription.settings.comments || config.do_issue_comments,
          commits: subscription.settings.commits || (config.do_commits ? 'all' : true),
          deployments: subscription.settings.deployments || config.do_deployment_status,
          issues: subscription.settings.issues || config.do_issues,
          pulls: subscription.settings.pulls || config.do_pullrequest,
          reviews: subscription.settings.reviews || config.do_pullrequest_reviews,
        },
      });

      return legacySubscription.markAsActivated();
    }));

    await respondWith(new Subscribed({ channelId: to, fromRepository: from }));
  } else if (command.subcommand === 'unsubscribe') {
    if (subscription) {
      if (settings) {
        subscription.disable(settings);
        await subscription.save();

        return respondWith(new Subscribed({ channelId: to, fromRepository: from }));
      }
      await Subscription.unsubscribe(from.id, to, slackWorkspace.id);
      return respondWith(new Subscribed({
        channelId: to,
        fromRepository: from,
        unsubscribed: true,
      }));
    }
    return respondWith(new NotSubscribed(command.args[0]));
  }
};