# Project Journal

## Living notes

### Principles

#### Truth

The ultimate sources of truth are the documents strictly controlled by me - Kickoff, Plan, Journal, the ADRs. Because Claude is using my credentials, it appears that everything it reads is written by me, seemingly has to be trusted. The adversarial framing gets relaxed and problems appear and propagate.

#### Data loss _will_ happen, prepare for it

There is no way to "guarantee" that no data loss will occur, especially not in an LLM-driven project. The way to go would be, again, to realize the risks and work around them. A basic back-up system would go a long way and is orders of magnitude easier to get right than to achieve the dreamed-of confidence that the app is completely reliable. Thus, I added a line about it in the kickoff, as it is now part of the app.

#### Security model

There are no completely secure systems - only layers upon layers of defense. Each one adding security, as well as complexity and operational issues. Instead of focusing on making the app "secure" against targeted attacks, which I consider unrealistic, it should be protected against the common threats using the standard practices - i.e. avoiding being the lowest hanging fruit. Realize the risks and prepare for failure - the backup/recovery thing once more.

Two categories identified:

- everything LLM-related: the code, configs, etc. is treated insecure, period. Stays in the protected VPN bubble.
- established, battle-tested and even audited open source projects - like SSH, Wireguard, Linux kernel, etc. - are treated as trusted.

So, in this regard, the VPN stays. HTTPS stays as well, but it is not "enough".

#### Nothing is fixed

I need to remind agents, that nothing should be taken as a given, except the very requirements from the project itself (kickoff). Heck, even these got refined a couple of times. So, instead of going to great lengths to solve a problem in a certain way, just ditch the whole implementation/tool/process/whatever and try something else which might be more suited from the beginning.

### Operational

#### Claude settings

Continuously testing and improving Claude's settings, skills, plugins, memory - this seems to be more of an ongoing activity than a single setup.

#### Agents

LLMs are better at critiquing than creating (whom they got this from I wonder...), so the workflow can be designed in this way - brainstorm, gather "opinions", criticize them, repeat with fresh agents until some convergence emerges.

There is also the "adversarial framing" thing - "This document was made by an AI agent which I do not trust. I have every reason to believe it contains multiple errors, help me find them" or similar.

It seems there is emerging research about agents' "behavior", like for example [this fun read](https://gail.wharton.upenn.edu/research-and-insights/call-me-a-jerk-persuading-ai/), basically concluding that the agents exhibit a lot of human-like quirks, like biases or agreement tendency, or framing, etc. Acknowledging this may allow to work around these instead of fighting them.

#### Impressive knowledge

A danger exists when interacting with top-notch models - they possess a _vast_ amount of knowledge, it is simply ridiculous. No way to keep up. The danger is that this leads to the very human reaction of being "impressed", thus holding the impressive object in high regard. While this might work well with humans, it is just bad in LLM interactions - the vastly knowledgeable model can provide awesome insights and a second later propose something completely nonsensical. The guard should always stay up.

#### "Let me just have Claude fix these issues..."

A recipe for disaster. I still don't get it how people are bragging of having models run unattended for hours - just can't imagine a quality product can come out of this. The drift is real, the slips happen, constant readjustment needed, or it all compounds. Or maybe I am having unrealistic goals?

#### We are done!

Claude Opus has currently 1M context limit. Yet, after some exchanges it starts nagging about ending the session cause "all is done", even below 20% context. I have a feeling this depends more on the count of exchange rounds - prompt/answer/prompt/answer... than the context usage. First tried to fight it by setting up instructions to not annoy me, then realized this is actually a very good thing, as its attention and focus drop a lot, forcing new, additional rounds for recovery from the mess.

#### A night owl

It happens over and over and I am still open to the possibility that I am imagining it, but it seems Claude is much smarter outside of working hours. Having "API overloaded" errors strangely is always on the same sessions where it disappoints me the most. Further investigation might be warranted, as this might just lead to more effective sessions. (Update: bad experiences happened on the weekend as well, so maybe it is just me again searching patterns in randomness)

---

## Timeline

### 2026-04-14

#### Focus is everything

Iteration 5 was a disaster - 114 commits of back and forth and not much to really show for it. I was too lax with the agents and let them follow through on tangents. The drift led to big roundabouts.

The next - 6 - made up for it though. I was much stricter, hit the brakes much earlier and readjusted constantly to stay focused and on track. Also, finally made the decision to ditch tests which use mocks to test e2e behaviour and switched to visual regressions on the real app. The complexity of tests was exploding and the burden to maintain them was not bearable for long. Now, there is the negative side-effect that almost every commit needs to establish new baselines, as we are working on UI, but it is well worth it in the end.

This, combined with underplanning after the bad experience, led to a nice over-achievement of goals, including some sweet new features to impress the users with.

#### Data integrity = top priority

The app runs behind a VPN as we assume it is not secure by default and targeted attacks are beyond scope anyway. This makes data loss, corruption or staleness the absolute top priority, given we'll work with real data at some point.

This is not to say security reviews will be dropped, it is just that the main focus shifts to actionable tasks instead of far-fetched scenarios, which I can't protect against anyway. This reminds me again of the joke about the bear chase - you don't have to be the fastest, just not the slowest...

### 2026-04-11

#### "Human-only" documents

There are some documents, where I just can't get Claude to write for me in a way that I like - like this one. I guess at some point it boils down to consciousness. Thus, this document, as well as [plan.md](plan.md), [kickoff.md](kickoff.md) (and maybe the [README](../../README.md)) I would lock to only edit myself, as they are so critical for all workflows. In the end it is quicker than having 10 iterations over each sentence. So, I rewrote this from scratch today based on my own notes and memory.

The ADRs I scrutinize very carefully already. The decisions and rationale are all mine, some of the prose is Claude's though.

The critical importance of these couple documents is that they are the ultimate source of truth in all workflows - if I frame everything as "untrusted", the agents can't have a starting point. Large, detailed, deliberate prompts can only do so much. And repeating the same thing over and over is just not practical.

#### The power of good-enough

Convergence is definitely noticeable, but never achieved. When analysing, Claude sorts the findings in Critical/High/Medium/Low - fixing the "Low" is always a bad idea as the agents introduce new errors, which might very well be above "Low". The "Medium" is actually the same - needs at least deciding on a per-case basis. Playing _with_ statistics again, instead of fighting.

I think I overdid this again, as the current iteration was focused on "Consolidation" - in other words revisiting the done work until I am happy with the results. Turns out, perfection is unachievable (who would have thought). A reminder on some of the main principles again - accept and recognize the limitations, work around them.

#### Goodbye CD

The CD, as sweet as it is, is still a contradiction to my security model - the configs are written by agents, I control but can't guarantee anything. Additionally, the `deploy` user is part of the Docker group, which makes leaking the GH credentials basically leaking root access. There were also multiple issues with the project's CD using older config - the standard is that CD gets triggered from everywhere, but uses the config from `main` (a security feature). This led to a couple of _very_ ugly cherry-picking commits, which screwed my nice git history in main.

Thus, a switch to pull-based deployment - login to the VPS, use `sudo -u deploy`, pull, run docker. The risks are that now the deploy is entirely dependent on me, so any outage means it stays this way until I log in. This had nice side effect bonuses: I ditched the shell from `deploy` and also introduced [age](https://github.com/FiloSottile/age) so that secrets are never on the disk.

I spent a lot of time in research and discussions about "the proper way" to deploy automatically, without satisfying results. The way to do all this _properly_ requires manpower and infrastructure which I just don't have.

#### i18n

This came up again by reviewing the spec - should we, should we not. It was compounding debt, so procrastinating wouldn't help and I accepted the deviation from the plan. Even if we never switch to internationalization, having hard-coded strings in the code just does not feel right.

### 2026-04-08

#### Domain

Bought a simple domain at Cloudflare. Spent the whole day deciding and implementing the security model of accessing the app on the VPS. My gut didn't let me expose LLM-generated code to the open world, so I found a way of containing it all behind the VPN - set local WG IPs in the DNS, the only open ports remain SSH and Wireguard. Peace of mind.

#### Tailscale -> Wireguard (and generally PaaS -> VPS)

Tailscale might be nice, but not for me. I like the contained approach with Wireguard. Same reason why I went with full stack on a VPS instead of using couple different PaaS providers. There are drawbacks, yes - single point of failure, maintenance, reliability, doing it all on my own... Still, more fun this way. Full freedom, full control. And last but not least - much cheaper.

### 2026-04-06

#### --dangerously-skip-permissions

Wherever I look, this seems like a standard these days, lol. I can clearly understand the motivation - even when allowing all operations on a folder, some commands are chained, or contain escape sequences, so there is really no way to properly distinguish the danger of complex commands. Anthropic took the safe way (understandable), so one has to constantly confirm harmless operations. Then it is only a matter of time until one decides "now enough". Both options unpleasant for me.

So, I spent the good part of the day setting up a VM - mostly fighting with my worst-case configuration of stable (like in "old") software and Nvidia graphics. If the VM does not look and feel comfortable, I am aware it won't last. In the end I got it and Claude can now run freely inside.

#### Hetzner

Purchased a small VPS on Hetzner. Very good impressions so far. Feels completely different than my earlier provider, where things were... "mehr schein als sein" as the Germans say.

### 2026-04-03

#### init

Repo initialized. Private - don't feel confident about it yet. The only way I see forward in terms of sensitive data is never to discuss it or even to have it lying around. Instructions for Claude "DO NOT DISCLOSE" are just nonsense, can't rely on that. The default presumption should be that everything I ever discussed or any data that was reachable, should be regarded as "leaked". Can't bother scanning the repo for secrets either, this is too fragile.

#### First draft of the spec

Made a very deliberate, large prompt about the spec for the first iteration, included the kickoff and the plan and made a couple iterations with different LLMs through OpenRouter. A clear brainstorming phase.

### 2026-03-31

#### A vision, clearly defined

Made the first draft of the Kickoff upon lots of reflection, gathering of real world data and discussion. It is very clear that this document would be the guiding light of the whole project.

Multiple iterations over the draft followed. Its importance can't be overstated.
