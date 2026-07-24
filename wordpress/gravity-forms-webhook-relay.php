<?php
/**
 * Plugin Name: Budai Tanc Gravity Forms Webhook Relay
 * Description: Sends Gravity Forms submissions to an external webhook without the paid Gravity Forms Webhooks add-on.
 * Version: 1.0.2
 */

if (!defined('ABSPATH')) {
    exit;
}

define('BUDAI_TANC_WEBHOOK_PIPELINES', array(
    array(
        'pipeline_id' => 'tanctanfolyam_jelentkezes',
        'form_id' => 4,
        'endpoint_url' => 'https://budaitancklub-registration-webhook.zsolt-3bf.workers.dev/webhooks/gravity-forms',
        // Add the same secret that is stored in Cloudflare as
        // WEBHOOK_SHARED_SECRET. Never commit the real value to Git.
        'shared_secret' => 'REPLACE_WITH_WEBHOOK_SHARED_SECRET',
        'course_field_label' => 'Választott tanfolyam',
        'payload_map' => array(
            'student_name' => array('type' => 'field', 'label' => 'Jelentkező (növendék) neve'),
            'submitted_at' => array('type' => 'entry', 'key' => 'date_created'),
            'start_date' => array('type' => 'field', 'label' => 'Részvétel kezdete'),
            'trial_signup' => array('type' => 'field', 'label' => 'Próba órára jelentkezés'),
            'birth_date' => array('type' => 'field', 'label' => 'Születési dátum'),
            'address' => array('type' => 'field', 'label' => 'Lakcím'),
            'phone' => array('type' => 'field', 'label' => 'Telefon'),
            'email' => array('type' => 'field', 'label' => 'E-mail cím'),
            'parent_name' => array('type' => 'field', 'label' => 'Törvényes képviselő, szülő neve'),
            'district_card_number' => array('type' => 'field', 'label' => 'Kerület Kártya száma'),
            'district_card_expiry' => array('type' => 'field', 'label' => 'Kerület Kártya lejárati dátuma'),
            'district_card_photo' => array('type' => 'field', 'label' => 'Kerület Kártya fotója'),
            'sibling_name' => array('type' => 'field', 'label' => 'Testvér neve'),
            'sibling_group' => array('type' => 'field', 'label' => 'Testvér csoportja'),
            'carryover_amount' => array('type' => 'field', 'label' => 'Rendelkezik jóváírható összeggel'),
            'billing_address' => array('type' => 'field', 'label' => 'Kérek számlát az alábbi adatokkal'),
            'billing_email' => array('type' => 'static', 'value' => ''),
        ),
    ),
));

add_action('gform_after_submission', 'budai_tanc_send_submission_to_webhook', 10, 2);

function budai_tanc_send_submission_to_webhook($entry, $form) {
    if (rgar($entry, 'status') === 'spam') {
        return;
    }

    $pipeline = budai_tanc_find_pipeline_config((int) $form['id']);
    if (!$pipeline) {
        return;
    }

    $payload = budai_tanc_build_payload($pipeline, $form, $entry);

    $response = wp_remote_post(
        $pipeline['endpoint_url'],
        array(
            'timeout' => 15,
            'headers' => array(
                'Content-Type' => 'application/json',
                'X-BudaiTanc-Secret' => $pipeline['shared_secret'],
            ),
            'body' => wp_json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
        )
    );

    if (is_wp_error($response)) {
        error_log('Budai Tanc webhook relay failed: ' . $response->get_error_message());
        return;
    }

    $status_code = wp_remote_retrieve_response_code($response);
    if ($status_code < 200 || $status_code >= 300) {
        error_log('Budai Tanc webhook relay returned HTTP ' . $status_code);
    }
}

function budai_tanc_gf_value_by_label($form, $entry, $target_label) {
    foreach ($form['fields'] as $field) {
        if (isset($field->label) && trim($field->label) === $target_label) {
            $input_id = (string) $field->id;
            $direct_value = trim((string) rgar($entry, $input_id));
            if ($direct_value !== '') {
                return $direct_value;
            }

            // Address, Name and other compound GF fields store their values
            // under sub-input IDs (for example 5.1 and 5.3), not field ID 5.
            $inputs = $field->get_entry_inputs();
            if (is_array($inputs)) {
                $values = array();
                foreach ($inputs as $input) {
                    $value = trim((string) rgar($entry, (string) $input['id']));
                    if ($value !== '') {
                        $values[] = $value;
                    }
                }
                return implode(', ', $values);
            }

            return '';
        }
    }

    return '';
}

function budai_tanc_find_pipeline_config($form_id) {
    foreach (BUDAI_TANC_WEBHOOK_PIPELINES as $pipeline) {
        if ((int) $pipeline['form_id'] === (int) $form_id) {
            return $pipeline;
        }
    }

    return null;
}

function budai_tanc_build_payload($pipeline, $form, $entry) {
    $payload = array(
        'pipeline_id' => $pipeline['pipeline_id'],
        'entry_id' => rgar($entry, 'id'),
        'form_id' => rgar($entry, 'form_id'),
    );

    if (!empty($pipeline['course_field_label'])) {
        $course_raw = budai_tanc_gf_value_by_label($form, $entry, $pipeline['course_field_label']);
        $course_parts = array_values(array_filter(array_map('trim', explode('/', $course_raw))));
        $payload['course_name'] = $course_raw;
        $payload['venue'] = $course_parts[1] ?? '';
        $payload['time'] = budai_tanc_join_course_time($course_parts);
        $payload['teacher'] = count($course_parts) >= 1 ? $course_parts[count($course_parts) - 1] : '';
    }

    foreach ($pipeline['payload_map'] as $payload_key => $definition) {
        if ($definition['type'] === 'field') {
            $payload[$payload_key] = budai_tanc_gf_value_by_label($form, $entry, $definition['label']);
            continue;
        }

        if ($definition['type'] === 'entry') {
            $payload[$payload_key] = trim((string) rgar($entry, $definition['key']));
            continue;
        }

        if ($definition['type'] === 'static') {
            $payload[$payload_key] = $definition['value'];
        }
    }

    return $payload;
}

function budai_tanc_join_course_time($course_parts) {
    if (count($course_parts) < 4) {
        return '';
    }

    $time_parts = array_slice($course_parts, 2, -1);
    $time = implode(', ', $time_parts);
    return str_replace(' ÉS PÉNTEK ', ', PÉNTEK ', $time);
}
