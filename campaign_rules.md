**Campaign Turn**

A player gets 2 Actions per Campaign Turn

Turn order - Logistics &gt; Movement &gt; Battles

*Forces*

Each Force has a starting Strength of 3. Each time a Force loses a battle, its Strength is reduced by 1. When a Force's Strength reaches 0, it is destroyed (i.e. 3 losses destroy a Force).

A Force can build back up its Strength by not engaging in a battle for a Campaign Turn, regaining 1 Strength.

To not engage in a battle, the Force must be in an Allegiance-controlled system without any opposing Forces also in the system.

*Logistics*

Each player starts with 2 Forces

Generate Force: costs 2 Actions. Creates a new Force at Strength 3, only in Allegiance-controlled system with no opposing Forces.

Reinforce: costs 1 Action. +1 Strength up to a maximum of 3, only in Allegiance-controlled system, including systems with opposing Forces.

Fortify: costs 1 Action. +1 System Durability up to a maximum of 10 (see System Control), only in Allegiance-controlled system, including systems with opposing Forces. The player must have one of their own active Forces present in that system (added as part of web app build).

*Movement*

Move: costs 1 Action. A player orders a Force they own from their current system to a connected system.

Hold: costs 0 Action. A player may give a Force they own the Hold action to remain in their current system. Hold is used in the Movement phase. If that Force already has a Move order, Hold cancels the order and refunds the action. Changing the destination of a Move that has not resolved yet does not spend another action.

*Battles*

Assignment: When forces from opposing sides are in the same system they are paired up to fight a battle. The players owning the forces are assigned a battle against each other. This includes forces that just moved into the system.

If a system has more forces from one side than another, then the side with fewer forces has those forces paired up again, equally distributing the opposing forces. For example, 2 Loyalist vs 5 Traitors would result in Loyalist Force A fighting 3 times against Traitor Force X, Y, Z and Loyalist Force B will fight 2 times against Traitor Forces M, N.

Resolution:

- Losing Force: Force Strength reduced by 1. If the Losing Force's Strength reaches 0, it is destroyed.
- Draws: Both forces count as Losing.
- Winning Force: Increases their faction's score (sys_loyal or sys_traitor) for the system by +1.
- Unable to schedule: the players are unable to mutually find the time to play this game. Neither player is penalized or gains a boon. (added as part of web app build)
- No Show: one of the players did not respond to their opponent's attempts to schedule the game, or did not show up to, or attempt to reschedule, their scheduled game. The offending player's force loses the battle. The reporting player gains an additional logistics point next turn. This battle must be confirmed by the campaign admin. (added as part of web app build)
- No Report: no report is made for the battle. Both players' forces suffer a loss. This must be confirmed by the campaign admin. (added as part of web app build)

*System Control/Influence*

Systems start with an admin-assigned level of sys_loyal and sys_traitor (default is 0 for each).

System control is determined by sys_loyal minus sys_traitor. A positive result means Loyalists control the system; a negative result means Traitors control the system. A result of zero means the system is Contested.

Each System starts with an admin-assigned durability level (sys_durability) (default is 5, maximum of 10). Each battle causes the sys_durability to decrease by 1.

Unable to schedule and No report do not change durability. A confirmed No show lowers durability the same way as any other win. (added as part of web app build)

Once System Durability reaches 0, each successive battle reduces the system's Power Level by 1.

*Campaign Turn Scoring*

At the end of every Campaign Turn, each side adds up the Power Level of their controlled systems and adds it to their overall Campaign Score.

If one side has twice the total Campaign Score of the other after 3 Campaign Turns, they are the victor.

If one side controls more than 70% of the Systems after 3 Campaign Turns, they are the victor.

If one side has had all their remaining forces reduced to a Force Strength of 1, then the opposing side is the victor.