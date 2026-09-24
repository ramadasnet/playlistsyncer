<script setup lang="ts">
const config = useRuntimeConfig()
const supportEmail = computed(() => String(config.public.supportEmail))
const siteUrl = computed(() => String(config.public.siteUrl || "https://playlistsyncer.com").replace(/\/$/, ""))

useSeoMeta({
    title: "Terms and Conditions · PlaylistSyncer",
    description: "Terms of service and privacy policy for PlaylistSyncer."
})
</script>

<template>
    <div class="shell page-shell">
        <PageHeading title="Terms and Conditions" description="Policy effective as of September 20th, 2026." />
        <div class="legal-stack">
            <section class="legal-panel" aria-labelledby="terms-about">
                <h2 id="terms-about">About PlaylistSyncer</h2>
                <p>
                    Please read these Terms of Service ("Terms", "Terms of Service") carefully before using the PlaylistSyncer website (the "Service"), available at
                    <a :href="siteUrl">{{ siteUrl }}</a
                    >, and operated by Igor Ramadas Leite Nogueira ("us", "we", or "our").
                </p>
                <p>
                    The Service is provided on an 'as is' and 'as available' basis. We do not guarantee that the service will be uninterrupted, timely, secure, or error-free. You acknowledge that you use the Service at your own risk and discretion.
                    Your access to and use of the Service is conditioned upon your acceptance of and compliance with these Terms. These Terms apply to all visitors, users and others who wish to access or use the Service. By accessing or using the
                    Service you agree to be bound by these Terms. If you disagree with any part of the terms then you do not have permission to access and use the Service.
                </p>
            </section>

            <section class="legal-panel" aria-labelledby="terms-privacy">
                <h2 id="terms-privacy">Privacy</h2>
                <p>Your privacy is important to us. It is our policy to respect your privacy and comply with any applicable law and regulation regarding any personal information we may collect about you.</p>
                <h3>Information we collect</h3>
                <p>
                    Information we collect includes both information you knowingly and actively provide us when using the Service, and any information automatically sent by your devices in the course of accessing the Service. We only ask for personal
                    information when we truly need it to provide a service to you. We collect it by fair and lawful means, with your knowledge and consent. We also let you know why we're collecting it and how it will be used.
                </p>
                <h3>Personal information</h3>
                <p>We may ask for personal information, or get information provided by third party integrations, which may include one or more of the following:</p>
                <ul>
                    <li>Music provider profile, such as Spotify, TIDAL, YouTube Music, or SoundCloud (required)</li>
                    <li>Email address</li>
                    <li>Playlist names and metadata</li>
                    <li>Track metadata, such as titles, artists, albums, and durations</li>
                    <li>Sync tasks, run history, and unmatched track matches</li>
                    <li>Weekly summary preferences</li>
                </ul>
                <h3>Security of your personal information</h3>
                <p>
                    When we collect and process personal information, and while we retain this information, we will protect it within commercially acceptable means to prevent loss and theft, as well as unauthorized access, disclosure, copying, use,
                    or modification.
                </p>
                <p>
                    Although we will do our best to protect the personal information you provide to us, we advise that no method of electronic transmission or storage is 100% secure, and no one can guarantee absolute data security. We will comply
                    with laws applicable to us in respect of any data breach.
                </p>
                <p>You are responsible for ensuring the security of your own information within the bounds of our services.</p>
                <h3>Storage of your personal information</h3>
                <p>
                    We keep your personal information only for as long as we need to. This time period may depend on what we are using your information for, in accordance with this policy. If your personal information is no longer required, we will
                    delete it within 30 days. Information stored in the server's access log cannot be removed on-demand, but it will be automatically discarded after around 90 days.
                </p>
                <h3>Disclosure of information to third parties</h3>
                <p>We do not disclose any of your personal information to unauthorized third parties or individuals, except when required by the EU law.</p>
                <p>If you subscribe to PlaylistSyncer PRO, some of your personal details will be exchanged with our Merchant of Record, Creem.</p>
                <h3>Controlling your personal information</h3>
                <p>You always retain the right to withhold personal information from us, with the understanding that your experience of the Service may be affected.</p>
                <p>
                    If we receive personal information about you from a third party, we will protect it as set out in this policy. If you believe that any information we hold about you is inaccurate, out of date, incomplete, irrelevant, or
                    misleading, please contact us using the details provided in this policy. We will take reasonable steps to correct any information found to be inaccurate, incomplete, misleading, or out of date.
                </p>
                <p>
                    If you believe that we have breached a relevant data protection law and wish to make a complaint, please contact us using the details provided at the footer of this policy and provide us with full details of the alleged breach. We
                    will promptly investigate your complaint and respond to you, setting out the outcome of our investigation and the steps we will take to deal with your complaint.
                </p>
            </section>

            <section class="legal-panel" aria-labelledby="terms-subscriptions">
                <h2 id="terms-subscriptions">Subscriptions</h2>
                <p>
                    Some of our services are available only via a subscription plan named PlaylistSyncer PRO (the "Subscription"), billed on a yearly basis. Free accounts can sync one playlist pair with a weekly automatic sync, while the Subscription
                    unlocks unlimited playlist pairs, more frequent automatic syncs, sync history, and weekly summaries.
                </p>
                <p>The yearly price of the Subscription is shown at checkout and may vary per country and date. The Subscription will automatically renew at the end of the billing cycle.</p>
                <h3>Merchant of Record</h3>
                <p>Creem acts as our Merchant of Record for Subscription payments.</p>
                <h3>Payment processing</h3>
                <p>
                    All Subscription payments are handled by our Merchant of Record, Creem. We do not collect, process or store credit cards, debit cards, bank details, or other sensitive payment details. All the information related to payment are
                    strictly stored and processed by our payment provider listed above.
                </p>
                <p>Questions about payment details should be sent directly to the payment provider, using their contact details that you received via email when the Subscription was made.</p>
                <h3>Fee changes</h3>
                <p>
                    At our discretion, we might change the price of the Subscription. Existing subscribers might be affected by the new price, but not before the end of their current billing cycle. We will try, however, to honor existing prices so
                    existing subscriptions are not affected by price changes, whenever possible.
                </p>
                <h3>Updates to the Subscription</h3>
                <p>
                    New features and integration with new services are not guaranteed in the future. Features that are currently available to Free accounts, might be removed and restricted to users paying for the Subscription. We do not guarantee
                    that existing features of the Subscription will be available in the future. We do, however, remove features only when strictly necessary, for example due to requests made by a music provider, or due to legal reasons.
                </p>
                <p>We might release special features that require additional payments in the future.</p>
                <h3>Cancellation of the Subscription</h3>
                <p>
                    Users are free to cancel their existing Subscription at any time, through the "Account" page of the Service, or by cancelling the payment for the next billing cycle directly on the payment platform. Cancellations are effective
                    immediately, unless stated otherwise during the cancellation process.
                </p>
                <h3>Suspension of the Subscription</h3>
                <p>
                    We reserve the right to suspend and cancel any existing Subscription, if we find that it is not being used in accordance with the Terms and Conditions of the Service, or due to legal reasons and sanctions. This applies to all
                    subscriptions, regardless of their payment date or payment method.
                </p>
            </section>

            <section class="legal-panel" aria-labelledby="terms-termination">
                <h2 id="terms-termination">Termination</h2>
                <p>
                    Users are free to stop using the Service at any time, for any reason, and can request their account to be deleted by contacting us at
                    <a :href="`mailto:${supportEmail}`">{{ supportEmail }}</a
                    >.
                </p>
                <p>
                    We may terminate or suspend your access to our Service immediately, with prior notice, if you breach the Terms and Conditions or if we are presented with a request from law enforcement. Upon termination, your right to use the
                    Service will immediately cease. If you have an active subscription at the time of termination, it will be cancelled.
                </p>
            </section>

            <section class="legal-panel" aria-labelledby="terms-refunds">
                <h2 id="terms-refunds">Refunds</h2>
                <p>
                    We do not guarantee refunds for any Subscription payments that have already been made. We do not guarantee refunds for a Subscription made by mistake. We do not issue refunds for subscriptions that were terminated due to breach of
                    the Terms, or due to law enforcement requests. We might, however, give partial refunds, at our discretion, on a per-case basis.
                </p>
                <p>It's your responsibility to cancel your Subscription before the next billing cycle, if you decide that you do not want to keep using the Subscription.</p>
                <p>All refunds are processed by our payment provider directly.</p>
            </section>

            <section class="legal-panel" aria-labelledby="terms-providers">
                <h2 id="terms-providers">Dependency on music providers</h2>
                <p>
                    The Service is dependent on third party music provider APIs, such as Spotify, TIDAL, YouTube Music, and SoundCloud. We cannot guarantee that these APIs will work or exist at any time in the future. If for any reason a provider
                    disables their API, restricts our access, or in the event that our connection to their API is terminated, the affected sync features of the Service will cease to work.
                </p>
            </section>

            <section class="legal-panel" aria-labelledby="terms-liability">
                <h2 id="terms-liability">Limitation of liability</h2>
                <p>
                    In no event shall PlaylistSyncer, nor its developers, partners, agents, suppliers, or affiliates, be liable for any indirect, incidental, special, consequential or punitive damages, including without limitation, loss of profits,
                    data, use, goodwill, or other intangible losses, resulting from:
                </p>
                <ul>
                    <li>Your access to or use of or inability to access or use the Service</li>
                    <li>Any conduct or content of any third party on the Service</li>
                    <li>Any content obtained from the Service</li>
                    <li>Unauthorized access to data transmitted to or from the Service</li>
                </ul>
            </section>

            <section class="legal-panel" aria-labelledby="terms-limits">
                <h2 id="terms-limits">Limits of our Terms</h2>
                <p>
                    Our website may link to external sites that are not operated by us. Please be aware that we have no control over the content and policies of those sites, and cannot accept responsibility or liability for their respective terms and
                    conditions.
                </p>
            </section>

            <section class="legal-panel" aria-labelledby="terms-changes">
                <h2 id="terms-changes">Changes to this policy</h2>
                <p>
                    At our discretion, we may change our Terms and Conditions to reflect updates to the Service, current acceptable practices, or legislative or regulatory changes. If we decide to change our Terms and Conditions, we will post the
                    changes here at the same link by which you are accessing now.
                </p>
            </section>

            <section class="legal-panel" aria-labelledby="terms-contact">
                <h2 id="terms-contact">Contact us</h2>
                <p>
                    For any questions or concerns, you may contact us on the following email:
                    <a :href="`mailto:${supportEmail}`">{{ supportEmail }}</a>
                </p>
            </section>
        </div>
    </div>
</template>
