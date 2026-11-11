/* eslint-env browser */
const test = require("node:test");
const assert = require("node:assert/strict");
const { firefox } = require("playwright");
const LoginPageHandlers = require("../src/accounts/LoginPageHandlers");
const LoginInteraction = require("../src/accounts/LoginInteraction");

const executablePath =
    process.env.ACCOUNT_LOGIN_BROWSER_TEST_EXECUTABLE ||
    (process.platform === "win32" && require("node:fs").existsSync(firefox.executablePath())
        ? firefox.executablePath()
        : undefined);
const title = "What brings you to Google AI Studio?";
// Mirrors the live page: no heading role, answers as a plain list, Skip as a
// bare text control in the footer and Continue disabled until an answer exists.
const surveyMarkup = ({ skip = "plain", continued = "false" } = {}) => `
    <div class="app-shell">
        <div class="survey">
            <div class="question">${title}</div>
            <div class="progress"><i></i><i></i></div>
            <div class="answers">
                <div class="row"><span>Explore latest models</span><span>+</span></div>
                <div class="row"><span>Develop with Gemini API</span><span>+</span></div>
                <div class="row"><span>Vibe code and bring your ideas to life</span><span>+</span></div>
                <div class="row"><span>Chat with Gemini</span><span>+</span></div>
            </div>
        </div>
        <div class="footer">
            ${
                skip === "plain"
                    ? `<div class="skip" onclick="document.querySelector('.survey').remove()">Skip</div>`
                    : skip === "button"
                      ? `<button onclick="document.querySelector('.survey').remove()">Skip</button>`
                      : skip === "hidden"
                        ? `<div class="skip" hidden onclick="document.querySelector('.survey').remove()">Skip</div>`
                        : skip === "disabled"
                          ? `<button disabled onclick="document.querySelector('.survey').remove()">Skip</button>`
                          : ""
            }
            <button class="continue" ${continued === "true" ? "" : "disabled"}
                onclick="document.body.dataset.continued='true';document.querySelector('.survey').remove()">Continue</button>
        </div>
    </div>`;

async function fixture(t, html, host = "aistudio.google.com") {
    const browser = await firefox.launch({ executablePath, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.route("**/*", route =>
        route.fulfill({ body: `<meta charset="utf-8">${html}`, contentType: "text/html; charset=utf-8" })
    );
    await page.goto(`https://${host}/test`);
    let clock = 0,
        cancelled = false;
    const interaction = new LoginInteraction({
        config: { humanize: false, stepTimeout: 3000 },
        deadline: performance.now() + 10000,
        guard: () => {
            if (cancelled) throw Object.assign(new Error("cancelled"), { reason: "cancelled" });
        },
        now: () => clock,
        sleep: async delay => {
            clock += delay;
        },
    });
    const handler = new LoginPageHandlers({
        deadline: performance.now() + 10000,
        guard: () => {
            if (cancelled) throw Object.assign(new Error("cancelled"), { reason: "cancelled" });
        },
        interaction,
        page,
        phase() {},
        stepTimeout: 1000,
    });
    return {
        cancel: () => {
            cancelled = true;
        },
        expire: () => {
            clock = performance.now() + 10000;
        },
        handler,
        interaction,
        page,
    };
}

function assertNoSelectionOrConfirmation(page) {
    return page.evaluate(() => {
        if ([...document.querySelectorAll('input[type="radio"]')].some(input => input.checked))
            throw Error("survey option selected");
        if (document.body.dataset.continued) throw Error("unrelated Continue clicked");
    });
}

test(
    "live welcome layout: footer Skip text is clicked without answering the survey",
    { skip: !executablePath },
    async t => {
        const { handler, page } = await fixture(t, surveyMarkup());
        assert.equal(await handler.skipWelcome(), true);
        assert.equal(await page.locator(".survey").count(), 0);
        await assertNoSelectionOrConfirmation(page);
    }
);

test("a Skip button and a plain-text Skip are both accepted", { skip: !executablePath }, async t => {
    for (const skip of ["plain", "button"]) {
        const { handler, page } = await fixture(t, surveyMarkup({ skip }));
        assert.equal(await handler.skipWelcome(), true, skip);
        assert.equal(await page.locator(".survey").count(), 0, skip);
        await assertNoSelectionOrConfirmation(page);
    }
});

test("Continue is a fallback only when Skip is hidden, disabled or missing", { skip: !executablePath }, async t => {
    for (const skip of ["hidden", "disabled", "missing"]) {
        const { handler, page } = await fixture(t, surveyMarkup({ continued: "true", skip }));
        assert.equal(await handler.skipWelcome(), true, skip);
        assert.equal(await page.locator(".survey").count(), 0, skip);
        assert.equal(await page.evaluate(() => document.body.dataset.continued), "true", skip);
    }
});

test("a disabled Continue without Skip reports a bounded timeout", { skip: !executablePath }, async t => {
    const { handler, page } = await fixture(t, surveyMarkup({ skip: "missing" }));
    await assert.rejects(handler.skipWelcome(), { reason: "onboarding_timeout" });
    await assertNoSelectionOrConfirmation(page);
});

test("unrelated challenges and third-party frames never authorize a click", { skip: !executablePath }, async t => {
    for (const { host, html } of [
        { host: "accounts.google.com", html: surveyMarkup() },
        {
            host: "aistudio.google.com",
            html: `<main><h2>Verify your identity</h2><button onclick="document.body.dataset.continued='true'">Continue</button></main>`,
        },
        {
            // The question alone, without the answer list, is not this survey.
            host: "aistudio.google.com",
            html: `<main><h2>${title}</h2><button onclick="document.body.dataset.continued='true'">Continue</button></main>`,
        },
    ]) {
        const { handler, page } = await fixture(t, html, host);
        assert.equal(await handler.skipWelcome(), false);
        await assertNoSelectionOrConfirmation(page);
    }
});

test("a changed challenge during click preparation cannot receive the click", { skip: !executablePath }, async t => {
    const { handler, interaction, page } = await fixture(t, surveyMarkup());
    interaction.pause = async () => {
        await page.locator(".question").evaluate(node => (node.textContent = "Verify your identity"));
    };
    await assert.rejects(handler.skipWelcome(), { reason: "challenge_changed" });
    await assertNoSelectionOrConfirmation(page);
});

test("page closure, cancellation and expiry stop welcome actions safely", { skip: !executablePath }, async t => {
    for (const mode of ["closed", "cancelled", "expired"]) {
        const { cancel, expire, handler, interaction, page } = await fixture(t, surveyMarkup());
        if (mode === "closed") await page.close();
        else {
            const original = interaction.click.bind(interaction);
            interaction.click = async (...args) => {
                if (mode === "cancelled") cancel();
                else expire();
                return original(...args);
            };
        }
        await assert.rejects(handler.skipWelcome(), error =>
            mode === "closed"
                ? error.reason === "challenge_changed" ||
                  /Target page, context or browser has been closed/.test(error.message)
                : error.reason === (mode === "cancelled" ? "cancelled" : "onboarding_timeout")
        );
        if (mode !== "closed") await assertNoSelectionOrConfirmation(page);
    }
});

test("failure diagnostics describe the survey without leaking any text", { skip: !executablePath }, async t => {
    const { handler } = await fixture(t, surveyMarkup());
    assert.equal(await handler.welcomePresent(), true);
    const structure = await handler.welcomeStructure();
    assert.ok(structure.nodes.length > 0, JSON.stringify(structure));
    const kinds = new Set(structure.nodes.map(node => node.kind));
    assert.ok(kinds.has("title"));
    assert.ok(kinds.has("answer"));
    assert.ok(kinds.has("skip"));
    assert.ok(structure.nodes.every(node => typeof node.tag === "string" && node.tag.length));
    const serialised = JSON.stringify(structure);
    assert.ok(!/What brings you/i.test(serialised));
    assert.ok(!/Explore latest/i.test(serialised));
    assert.ok(!/password|user@example/i.test(serialised));
});
test(
    "a welcome that does not navigate consumes one fixed budget instead of polling forever",
    { skip: !executablePath },
    async t => {
        const { handler, interaction, page } = await fixture(t, surveyMarkup());
        handler.stepTimeout = 200;
        const originalClick = interaction.click.bind(interaction);
        interaction.click = async () => {
            await new Promise(resolve => setTimeout(resolve, 250));
        };
        await assert.rejects(handler.skipWelcome(), { reason: "onboarding_timeout" });
        interaction.click = originalClick;
        await assert.rejects(handler.skipWelcome(), { reason: "onboarding_timeout" });
        assert.equal(await page.evaluate(() => document.body.dataset.continued), undefined);
    }
);
