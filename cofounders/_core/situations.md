# Situations

Each section is one situation a cofounder has a playbook for. The server detects the situation from the message, the page, the insight that started the turn and what the turn produced (a card, a question). The mood is fixed here, per situation, so it never depends on the model.

Fields: `title`, `mood` (neutral | thinking | explaining | happy | serious | surprised | disappointed | laughing), `tag` (the short label under the headline word), `money` (true means it is never loaded in a Telegram group), `keywords` (phrases in the message), `sources` (insight source prefixes), `tools` (a proposed or finished card from one of these tools means this situation), `problem` (the label in the founder quiz, optional).

## overdue_invoice
title: An invoice is overdue
mood: serious
tag: Needs attention
money: true
keywords: overdue, owes me, owe me, owes us, late on, days late, hasn't paid, has not paid, not paid, unpaid, chase, payment pending, paisa nahi, baki hai, udhaar
sources: insight:overdue, insight:invoice_overdue, insight:receivable
tools: send_payment_reminder
problem: Clients pay late

## low_runway
title: Runway is getting short
mood: serious
tag: Needs attention
money: true
keywords: runway, running out of cash, cash is low, low on cash, burn rate, can we afford, how long can we last, cash crunch, paise khatam
sources: insight:runway, insight:cash_low
problem: Cash is tight

## slipping_deadline
title: A deadline has slipped
mood: serious
tag: Needs attention
money: false
keywords: missed the deadline, deadline slipped, slipping, running late, delayed, behind schedule, overdue task, won't make it, not going to make it, late ho gaya
sources: insight:task_overdue, insight:deadline, insight:project_at_risk
problem: Work keeps slipping

## unusual_spend
title: Spending looks unusual
mood: surprised
tag: Unusual
money: true
keywords: spending too much, unusual spend, expenses are up, costs are up, why is spend, overspent, over budget, big purchase, kharcha zyada
sources: insight:spend, insight:expense_spike
problem: Costs keep creeping up

## gst_due
title: A GST filing is due
mood: serious
tag: Needs attention
money: true
keywords: gst due, gst filing, gstr, gst return, file gst, gst deadline, tax due
sources: insight:gst, insight:tax_due
problem: GST and compliance

## payment_received
title: A payment came in
mood: happy
tag: Good news
money: true
keywords: paid us, paid the invoice, payment received, payment came in, came in by upi, got the payment, settled, paisa aa gaya, payment aa gaya, did they pay
sources: insight:payment_in
tools: record_payment, mark_invoice_paid

## task_done
title: Work got finished
mood: happy
tag: Good news
money: false
keywords: finished, completed, done with, wrapped up, shipped, delivered, ho gaya, khatam kar diya
sources: insight:task_done
tools: complete_task

## missing_info
title: A detail is missing
mood: thinking
tag: Needs info
money: false

## quick_pick
title: A quick choice is needed
mood: thinking
tag: Needs info
money: false

## discount_request
title: A client wants a discount
mood: thinking
tag: Your call
money: true
keywords: discount, lower the price, reduce the price, too expensive, negotiate, wants it cheaper, kam karo, best price
problem: Clients push on price

## hiring_decision
title: A hiring decision
mood: thinking
tag: Your call
money: false
keywords: should we hire, hire a, new hire, offer letter to, bring on a, need a developer, need a designer, recruit
problem: Hiring the right people

## deal_won
title: A deal was won
mood: laughing
tag: Big win
money: true
keywords: accepted the quote, accepted the quotation, signed, deal won, we won, closed the deal, they said yes, deal ho gaya, order confirmed
sources: insight:deal_won
tools: convert_quotation
problem: Not enough new deals

## milestone
title: A milestone was reached
mood: laughing
tag: Big win
money: false
keywords: milestone, launched, went live, first customer, hundredth, 100th, anniversary, project completed
sources: insight:milestone, insight:project_done

## record_high
title: A record was set
mood: surprised
tag: New record
money: true
keywords: best month, record month, highest ever, biggest deal, biggest invoice, all-time high, sabse zyada
sources: insight:record

## deal_lost
title: A deal was lost
mood: disappointed
tag: Lost one
money: true
keywords: lost the deal, deal lost, we lost, went with someone else, went with another, rejected the quote, declined the quote, backed out, cancelled the order, pulled out, deal cancel ho gaya, mana kar diya
sources: insight:deal_lost
problem: Losing deals we should win

# Actions

The advisory moves a playbook can list. None of them is a tool call; they name what the cofounder recommends, in order.

- check_records: look at the records before saying anything
- remind_now: send a written reminder today
- flag_runway: say what this does to runway
- call_personally: pick up the phone instead of writing
- offer_instalments: split the amount into instalments
- pitch_upsell: raise the next piece of work in the same conversation
- deprioritise: leave it for now; it is not the main thing
- redirect_to_product: move the attention to the product or the work itself
- set_deadline: give a firm date
- pause_work: stop new work until this is settled
- freeze_spend: hold non-essential spending
- freeze_hiring: hold new hires
- cut_cost: remove a cost
- cut_scope: do less, better
- hold_price: keep the price where it is
- offer_terms: give on payment terms instead of price
- add_value: give more instead of charging less
- walk_away: decline the deal
- ask_customer: ask the customer what is behind it
- log_now: record it now, while it is fresh
- verify_document: check the bill or document first
- reassign: move the work to someone with room
- escalate: tell the person who needs to know
- reset_date: agree a new date openly
- file_early: file ahead of the due date
- delegate_admin: hand the admin to someone else
- bank_it: keep the cash; do not spend it yet
- reinvest_in_product: put it back into the product
- invoice_now: raise the invoice at once
- thank_client: thank the client personally
- ask_referral: ask for a referral or an introduction
- raise_the_bar: set a harder target next
- celebrate_briefly: mark the win, then move on
- share_with_team: tell the team
- ask_one_question: ask the one question that decides it
- offer_options: give two or three options to choose from
- start_small: try it small first
- delay_decision: wait for more information
- decide_now: decide now with what is known
- hire_for_taste: hire only someone exceptional
- hire_contract_first: start with a contract or trial
- hire_for_network: hire the person who brings relationships
- question_requirement: ask why this is required at all, and who asked for it
- remove_step: take out a step, part or process that is not needed
- fix_root_cause: change the cause so it cannot happen again
- go_to_bottleneck: go to the exact point where it is stuck
- speed_up: shorten the cycle; do it sooner
- automate_it: make it run by itself once it is simple
- look_at_data: look at the pattern across all the records, not the one case
- run_test: try it on a few, measure, then decide
- ship_now: ship what is ready now and improve it after
- double_down: put more behind what is already working
- upfront_payment: move to a deposit or payment upfront
- hire_builder: hire someone who has done the hard part with their own hands

# Cues

Words in the founder's message that set a mood when no situation applies. A cue has no playbook. Checked in this order; the first with a matching phrase wins.

- laughing: haha, hahaha, hehe, lol, lmao, rofl, 😂, 🤣, just kidding
- explaining: how do i, how do we, how to, how should, how does, how can, why is, why are, why did, why does, explain, what does, what should, walk me through, difference between, help me understand, kaise, kyun, samjhao
- neutral: thanks, thank you, thx, shukriya, hello, hi, hey, good morning, good evening, namaste

# Metrics

The figures an answer can carry, how each one reads, and how asking for it is worded. `kind` is gain (more is good), balance (signed), cost (less is good) or problem (any at all is bad); `money` means it is never read in a Telegram group. The focus of a question is the first metric here that the message names and the answer has a figure for.

- money_in: gain, money; revenue, sales, income, money in, earned, earning, earnings, collected, came in, received, kamai, kitna aaya
- invoiced: gain, money; invoiced, billed, billing
- pipeline: gain; leads, lead, pipeline, prospects, deals in
- net: balance, money; net, profit, cash flow, net cash, bacha
- money_out: cost, money; expense, expenses, spend, spent, spending, costs, cost, money out, kharcha
- payables: cost, money; we owe, vendor bills, payable, payables, bills to pay
- overdue_tasks: problem; overdue, late, behind, overdue tasks, late tasks
- open_tasks: cost; pending, open tasks, to do, left to do, pending tasks
- overdue: problem, money; overdue, late payment, unpaid, baki
